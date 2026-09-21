/**
 * Executes a scoring run.
 *
 * One Jev request per transcript chunk, carrying every enabled rubric. A
 * transcript that fits — which is almost all of them — is therefore one request
 * for the whole session no matter how many rubrics are in the library.
 */
import { randomUUID } from 'node:crypto';
import type { OdataClient, SessionSummary } from '../cognigy/odata.ts';
import { assemble, render, type Transcript } from '../cognigy/transcript.ts';
import { ask } from '../jev.ts';
import { Ledger } from '../metering.ts';
import { compile, questionId } from '../rubrics/compile.ts';
import type { Rubric } from '../rubrics/model.ts';
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
): Promise<{ results: Omit<ResultRow, 'runId' | 'sessionId'>[]; chunks: number }> {
  const questions = compile(rubrics);
  const questionTokens = estimateTokens(JSON.stringify(questions));
  const chunks = chunkTurns(transcript.turns, stateBudget(questionTokens));

  const perRubric = new Map<string, ChunkAnswer[]>();

  for (const [index, turns] of chunks.entries()) {
    const state = {
      conversation: render({ ...transcript, turns }),
      ...(chunks.length > 1 ? { part: `${index + 1} of ${chunks.length}` } : {}),
      ...(transcript.flowName ? { flow: transcript.flowName } : {}),
    };

    const { answers } = await ask({
      stage: 'score',
      label: `${transcript.sessionId}${chunks.length > 1 ? ` [${index + 1}/${chunks.length}]` : ''}`,
      state,
      questions,
      ledger,
      sessionId: transcript.sessionId,
    });

    for (const rubric of rubrics) {
      const answer = readAnswer(rubric, answers as Record<string, unknown>, turns.length);
      if (!answer) continue;
      const list = perRubric.get(rubric.id);
      if (list) list.push(answer);
      else perRubric.set(rubric.id, [answer]);
    }
  }

  const results: Omit<ResultRow, 'runId' | 'sessionId'>[] = [];
  for (const rubric of rubrics) {
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

  return { results, chunks: chunks.length };
}

export async function executeRun(
  request: RunRequest,
  deps: { odata: OdataClient; store: Store; rubrics: Rubric[] },
  onProgress?: (progress: RunProgress) => void,
): Promise<{ run: RunRow; ledger: Ledger }> {
  const { odata, store, rubrics } = deps;
  const enabled = rubrics.filter((rubric) => rubric.enabled);
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
    channels: request.channels,
    limit: request.limit,
  });

  if (request.skipScored) {
    const seen = store.alreadyScored(request.projectId);
    candidates = candidates.filter((session) => !seen.has(session.sessionId));
  }

  let done = 0;
  let split = 0;

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
    const records = await odata.conversation(request.projectId, summary.sessionId);
    const transcript = assemble(summary.sessionId, records);

    let results: Omit<ResultRow, 'runId' | 'sessionId'>[] = [];
    let chunks = 0;

    if (!transcript.unscoreable) {
      const scored = await scoreTranscript(transcript, enabled, ledger);
      results = scored.results;
      chunks = scored.chunks;
      if (chunks > 1) split++;
    }

    const spend = ledger.totals(ledger.since(sessionStart));
    const row: SessionRow = {
      runId,
      sessionId: summary.sessionId,
      startedAt: transcript.turns[0]?.at ?? summary.startedAt,
      endpointLabel: transcript.endpointLabel,
      channel: transcript.channel,
      channelLabel: transcript.channelLabel.label,
      flowName: transcript.flowName,
      turns: transcript.turns.length,
      chunks,
      rating: transcript.rating,
      ratingComment: transcript.ratingComment,
      unscoreable: transcript.unscoreable ?? null,
      transcript: JSON.stringify(transcript.turns),
      costUsd: spend.costUsd,
      ms: Date.now() - sessionMs,
    };

    store.saveSession(
      row,
      results.map((result) => ({ ...result, runId, sessionId: summary.sessionId })),
    );
    done++;
  }

  const totals = ledger.totals();
  const run: RunRow = {
    id: runId,
    startedAt,
    projectId: request.projectId,
    projectName: request.projectName,
    endpointLabel:
      request.endpointName === null
        ? 'Interaction Panel'
        : (request.endpointName ?? 'Any endpoint'),
    fromTs: request.from,
    toTs: request.to,
    sessions: done,
    costUsd: totals.costUsd,
    ms: Date.now() - startedMs,
  };
  store.saveRun(run);

  onProgress?.({ done, total: candidates.length, costUsd: totals.costUsd, chunksSplit: split });
  return { run, ledger };
}
