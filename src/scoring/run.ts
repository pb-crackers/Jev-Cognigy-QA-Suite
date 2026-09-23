/**
 * Executes a scoring run.
 *
 * One Jev request per transcript chunk, carrying every enabled rubric. A
 * transcript that fits — which is almost all of them — is therefore one request
 * for the whole session no matter how many rubrics are in the library.
 */
import { randomUUID } from 'node:crypto';
import type { OdataClient, SessionSummary } from '../cognigy/odata.ts';
import { labelFor, modalityOf } from '../cognigy/channels.ts';
import { assemble, render, type Transcript } from '../cognigy/transcript.ts';
import { ask } from '../jev.ts';
import { Ledger } from '../metering.ts';
import { applicable, compile, questionId } from '../rubrics/compile.ts';
import { traceReady, type Rubric } from '../rubrics/model.ts';
import type { TraceCoverage } from '../store/db.ts';
import { reconstruct, traceCoverage, type SessionTrace } from '../traces/reconstruct.ts';
import { fixedState, fixedTokens, withToolLines } from './state.ts';
import { checkSession, checkToolCalls } from '../checks/exact.ts';
import { chunkTurns, estimateTokens, stateBudget } from './chunk.ts';
import { combineAnswers, type ChunkAnswer } from './combine.ts';
import type { ResultRow, RunRow, SessionRow, Store } from '../store/db.ts';

export interface RunRequest {
  projectId: string;
  projectName: string;
  /** Endpoint name, `null` for Interaction Panel only, undefined for any. */
  endpointName?: string | null;
  from: string;
  to: string;
  /** Raw channel values to include; omitted means every channel. */
  channels?: readonly string[];
  limit: number;
  skipScored: boolean;

  /** Set when the run collects for an agent. */
  agentId?: string;
  /** What the run is called in the run list; derived from the endpoint when absent. */
  label?: string;
  /** An agent's endpoints by name; overrides `endpointName`. */
  endpointNames?: readonly string[];
  includePanel?: boolean;
  panelFlowNames?: readonly string[];
  /**
   * Restricts the run to these rubrics — an agent's set. Omitted means every
   * enabled rubric, as an ad-hoc run has always done.
   */
  rubricIds?: readonly string[];
  /**
   * `session` skips a session scored before at all — the ad-hoc behaviour.
   * `rubric` skips per session × rubric and asks only what is missing, and
   * re-scores a session that has grown since it was last seen.
   */
  skipMode?: 'session' | 'rubric';
  oldestFirst?: boolean;
  /**
   * A session whose newest record is later than this is still in progress and
   * is deferred rather than scored half-finished.
   */
  settledBefore?: string;
  /** Sessions whose earlier scoring failed, retried whatever the time range. */
  retrySessionIds?: readonly string[];
}

export interface RunOutcome {
  run: RunRow;
  ledger: Ledger;
  /** Sessions held back because they were still in progress. */
  deferred: SessionSummary[];
  /** Sessions actually scored, with the conversation time of their last record. */
  scored: { sessionId: string; startedAt: string; lastAt: string }[];
  /**
   * Sessions discovery returned, before any were deferred or skipped. Equal to
   * the limit means there may be more waiting.
   */
  found: SessionSummary[];
  /** Discovery stopped at its record cap, so there may be more waiting whatever `found` says. */
  truncated: boolean;
  /** Sessions whose scoring failed this run, recorded with why and retried later. */
  failed: { sessionId: string; error: string; attempts: number }[];
}

export interface RunProgress {
  done: number;
  total: number;
  costUsd: number;
  chunksSplit: number;
  currentSession?: string;
}

/** Reads one rubric's answer out of a Jev response. */
function readAnswer(
  rubric: Rubric,
  answers: Record<string, unknown>,
  turnCount: number,
): ChunkAnswer | undefined {
  const answer = answers[questionId(rubric)] as
    | { noul?: number; score?: number; choice?: string; confidence?: number }
    | undefined;
  if (!answer) return undefined;

  if (rubric.type === 'boolean') {
    return answer.noul === undefined ? undefined : { raw: answer.noul, weight: turnCount };
  }
  if (rubric.type === 'score') {
    return answer.score === undefined
      ? undefined
      : { raw: answer.score, confidence: answer.confidence, weight: turnCount };
  }
  return answer.choice === undefined
    ? undefined
    : { raw: answer.choice, confidence: answer.confidence, weight: turnCount };
}

async function scoreTranscript(
  transcript: Transcript,
  rubrics: Rubric[],
  ledger: Ledger,
  trace?: { session: SessionTrace | undefined; coverage: TraceCoverage },
): Promise<{ results: Omit<ResultRow, 'runId' | 'sessionId'>[]; chunks: number; turns: Transcript['turns'] }> {
  // A rubric can be scoped to one modality, so the set asked of this transcript
  // is derived once and used both to build the questions and to read the answers
  // back. Deriving it twice is how the two would drift.
  const modality = modalityOf(transcript.channelLabel.kind);
  const asked = applicable(rubrics, modality).filter((rubric) => traceReady(rubric, trace?.coverage));
  const questions = compile(asked, modality);
  const questionTokens = estimateTokens(JSON.stringify(questions));

  // The instructions and tools are the same for every chunk, so they come out
  // of the budget before the conversation is divided.
  const fixed = fixedState(trace?.session);
  const turnsWithTools = withToolLines(transcript.turns, trace?.session);
  const chunks = chunkTurns(turnsWithTools, stateBudget(questionTokens) - fixedTokens(fixed));
  if (asked.length === 0) return { results: [], chunks: 0, turns: turnsWithTools };

  const perRubric = new Map<string, ChunkAnswer[]>();

  for (const [index, turns] of chunks.entries()) {
    const state = {
      conversation: render({ ...transcript, turns }),
      ...(chunks.length > 1 ? { part: `${index + 1} of ${chunks.length}` } : {}),
      ...(transcript.flowName ? { flow: transcript.flowName } : {}),
      ...fixed,
    };

    const { answers } = await ask({
      stage: 'score',
      label: `${transcript.sessionId}${chunks.length > 1 ? ` [${index + 1}/${chunks.length}]` : ''}`,
      state,
      questions,
      ledger,
      sessionId: transcript.sessionId,
    });

    for (const rubric of asked) {
      const answer = readAnswer(rubric, answers as Record<string, unknown>, turns.length);
      if (!answer) continue;
      const list = perRubric.get(rubric.id);
      if (list) list.push(answer);
      else perRubric.set(rubric.id, [answer]);
    }
  }

  const results: Omit<ResultRow, 'runId' | 'sessionId'>[] = [];
  for (const rubric of asked) {
    const answers = perRubric.get(rubric.id);
    if (!answers?.length) continue;
    const combined = combineAnswers(rubric, answers);
    results.push({
      rubricId: rubric.id,
      raw: String(combined.raw),
      confidence: combined.confidence ?? null,
      chunks: combined.chunks,
      decidedBy: combined.decidedBy ?? null,
    });
  }

  return { results, chunks: chunks.length, turns: turnsWithTools };
}

/**
 * Asks stored sessions' rubrics again, with the state they were scored with.
 *
 * Used to measure stability: Jev can answer byte-identical requests
 * differently, and how often a rubric's verdict flips on a re-ask is a direct
 * measure of how far its answers can be trusted. Only single-chunk sessions are
 * re-asked, so the comparison is like for like.
 */
export async function reaskSession(
  session: SessionRow,
  rubrics: Rubric[],
  ledger: Ledger,
  trace?: SessionTrace,
): Promise<Map<string, ChunkAnswer>> {
  const stored = JSON.parse(session.transcript) as Transcript['turns'];
  // Sessions scored before tool calls had their own records kept the lines in
  // the transcript itself; newer ones get them placed back, as scoring did.
  const turns = stored.some((turn) => turn.tool) ? stored : withToolLines(stored, trace);
  const fixed = fixedState(trace);
  const modality = modalityOf(labelFor(session.channel).kind);
  const questions = compile(rubrics, modality);
  const state = {
    conversation: render({ turns } as Transcript),
    ...(session.flowName ? { flow: session.flowName } : {}),
    ...fixed,
  };
  const { answers } = await ask({
    stage: 'score',
    label: `${session.sessionId} [re-ask]`,
    state,
    questions,
    ledger,
    sessionId: session.sessionId,
  });
  const out = new Map<string, ChunkAnswer>();
  for (const rubric of rubrics) {
    const answer = readAnswer(rubric, answers as Record<string, unknown>, turns.length);
    if (answer) out.set(rubric.id, answer);
  }
  return out;
}

/** What a stored session row says about where it came from, scored or not. */
function sessionBasics(runId: string, summary: SessionSummary, transcript: Transcript | undefined) {
  return {
    runId,
    sessionId: summary.sessionId,
    startedAt: transcript?.turns[0]?.at ?? summary.startedAt,
    endpointLabel: transcript?.endpointLabel ?? summary.endpointName ?? 'Interaction Panel',
    channel: transcript?.channel ?? summary.channel,
    channelLabel: transcript?.channelLabel.label ?? labelFor(summary.channel).label,
    flowName: transcript?.flowName ?? null,
    turns: transcript?.turns.length ?? 0,
    rating: transcript?.rating ?? summary.rating,
    ratingComment: transcript?.ratingComment ?? null,
    unscoreable: transcript?.unscoreable ?? null,
    lastAt: summary.lastAt,
  };
}

export async function executeRun(
  request: RunRequest,
  deps: { odata: OdataClient; store: Store; rubrics: Rubric[] },
  onProgress?: (progress: RunProgress) => void,
): Promise<RunOutcome> {
  const { odata, store, rubrics } = deps;
  const wanted = request.rubricIds ? new Set(request.rubricIds) : undefined;
  const enabled = rubrics.filter((rubric) => rubric.enabled && (!wanted || wanted.has(rubric.id)));
  if (enabled.length === 0) throw new Error('No rubrics are enabled');

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const ledger = new Ledger();
  const startedMs = Date.now();

  let candidates = await odata.sessions({
    projectId: request.projectId,
    from: request.from,
    to: request.to,
    endpointName: request.endpointName,
    endpointNames: request.endpointNames,
    includePanel: request.includePanel,
    panelFlowNames: request.panelFlowNames,
    oldestFirst: request.oldestFirst,
    channels: request.channels,
    limit: request.limit,
  });

  const found = candidates;
  const deferred = request.settledBefore
    ? candidates.filter((session) => session.lastAt > request.settledBefore!)
    : [];
  if (deferred.length) {
    const held = new Set(deferred.map((session) => session.sessionId));
    candidates = candidates.filter((session) => !held.has(session.sessionId));
  }

  // Failed sessions come back whenever they happened, in small batches. They
  // join after discovery is counted: an old session retried must not look like
  // a full batch, or pull the watermark back to when it happened.
  const retried = new Set(request.retrySessionIds ?? []);
  const retry = [...retried].filter((id) => !candidates.some((session) => session.sessionId === id));
  for (let index = 0; index < retry.length; index += 20) {
    const batch = await odata.sessions({
      projectId: request.projectId,
      from: request.from,
      to: request.to,
      endpointNames: request.endpointNames,
      includePanel: request.includePanel,
      panelFlowNames: request.panelFlowNames,
      sessionIds: retry.slice(index, index + 20),
      limit: 20,
    });
    candidates = [...candidates, ...batch];
  }
  const priorFailures = new Map(
    request.agentId ? store.failedSessions(request.agentId).map((failure) => [failure.sessionId, failure.attempts]) : [],
  );

  // Which rubrics each session still needs. Ad-hoc runs keep the per-session
  // skip they have always had; agent runs ask only what is missing.
  const needs = new Map<string, Rubric[]>();
  if (request.skipScored && request.skipMode === 'rubric') {
    const scored = store.scoredRubrics(candidates.map((session) => session.sessionId));
    for (const session of candidates) {
      const seen = scored.get(session.sessionId);
      const grew = seen?.lastAt && session.lastAt > seen.lastAt;
      needs.set(
        session.sessionId,
        !seen || grew ? enabled : enabled.filter((rubric) => !seen.rubrics.has(rubric.id)),
      );
    }
    // A session whose every answer came from an earlier ad-hoc run still has to be
    // recorded under the agent: its health and alerts read only the agent's own
    // sessions. It is kept with nothing to ask — no Jev call, just the row.
    // A retried session is always processed, even with nothing left to ask:
    // recording it cleanly is what clears the failure.
    candidates = candidates.filter((session) =>
      (needs.get(session.sessionId)?.length ?? 0) > 0 ||
      retried.has(session.sessionId) ||
      (request.agentId !== undefined && !store.agentHasSession(request.agentId, session.sessionId)));
  } else if (request.skipScored) {
    const seen = store.alreadyScored(request.projectId);
    candidates = candidates.filter((session) => !seen.has(session.sessionId));
  }

  let done = 0;
  let split = 0;
  const scoredSessions: RunOutcome['scored'] = [];
  const failed: RunOutcome['failed'] = [];

  for (const summary of candidates) {
    onProgress?.({
      done,
      total: candidates.length,
      costUsd: ledger.totals().costUsd,
      chunksSplit: split,
      currentSession: summary.sessionId,
    });

    const sessionStart = ledger.mark;
    const sessionMs = Date.now();
    let transcript: Transcript | undefined;
    // One session going wrong — a Jev timeout, a payload nobody has seen — is
    // recorded against that session and retried later; the rest carry on.
    try {
      const records = await odata.conversation(request.projectId, summary.sessionId);
      transcript = assemble(summary.sessionId, records);

      let results: Omit<ResultRow, 'runId' | 'sessionId'>[] = [];
      let chunks = 0;

      // Only an agent has traces: its webhook is where they arrive.
      const traces = request.agentId ? store.tracesFor(request.agentId, summary.sessionId) : [];
      const session = traces.length ? reconstruct(traces) : undefined;
      if (session) checkToolCalls(session.toolCalls, session.tools, session.lastCallAt);
      const coverage = request.agentId ? traceCoverage(transcript.turns, session) : null;

      if (!transcript.unscoreable) {
        const scored = await scoreTranscript(
          transcript,
          needs.get(summary.sessionId) ?? enabled,
          ledger,
          coverage ? { session, coverage } : undefined,
        );
        results = scored.results;
        chunks = scored.chunks;
        if (chunks > 1) split++;
      }

      const spend = ledger.totals(ledger.since(sessionStart));
      store.saveSession(
        {
          ...sessionBasics(runId, summary, transcript),
          chunks,
          // The conversation as it happened. Tool calls live in their own records
          // and are placed into it when shown, the same way the grader saw them.
          transcript: JSON.stringify(transcript.turns),
          costUsd: spend.costUsd,
          ms: Date.now() - sessionMs,
          traceCoverage: coverage,
          checks: request.agentId ? JSON.stringify(checkSession(transcript.turns, session)) : null,
        },
        results.map((result) => ({ ...result, runId, sessionId: summary.sessionId })),
      );
      if (request.agentId && session) store.saveToolCalls(request.agentId, summary.sessionId, session.toolCalls);
      scoredSessions.push({ sessionId: summary.sessionId, startedAt: transcript.turns[0]?.at ?? summary.startedAt, lastAt: summary.lastAt });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const attempts = (priorFailures.get(summary.sessionId) ?? 0) + 1;
      store.saveSession(
        {
          ...sessionBasics(runId, summary, transcript),
          chunks: 0,
          transcript: JSON.stringify(transcript?.turns ?? []),
          costUsd: ledger.totals(ledger.since(sessionStart)).costUsd,
          ms: Date.now() - sessionMs,
          error: reason,
          attempts,
        },
        [],
      );
      failed.push({ sessionId: summary.sessionId, error: reason, attempts });
    }
    done++;
  }

  const totals = ledger.totals();
  const run: RunRow = {
    id: runId,
    startedAt,
    projectId: request.projectId,
    projectName: request.projectName,
    endpointLabel:
      request.label ??
      (request.endpointName === null ? 'Interaction Panel' : (request.endpointName ?? 'Any endpoint')),
    fromTs: request.from,
    toTs: request.to,
    sessions: done,
    costUsd: totals.costUsd,
    ms: Date.now() - startedMs,
    agentId: request.agentId ?? null,
  };
  store.saveRun(run);

  onProgress?.({ done, total: candidates.length, costUsd: totals.costUsd, chunksSplit: split });
  return { run, ledger, deferred, scored: scoredSessions, found, truncated: Boolean(found.truncated), failed };
}
