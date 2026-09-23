/**
 * One collection for one agent: pull what is new, score it, fire alerts.
 *
 * The watermark is the instant before which everything settled has been
 * collected. Each collection reads from there to now, scores sessions that have
 * gone quiet, and defers ones still in progress — a session whose newest record
 * is inside the settle window is someone mid-conversation. A deferred session
 * still has records after the new watermark, so the next collection finds it.
 *
 * After a gap — the laptop was closed — the watermark is days old and the first
 * collection walks forward oldest-first in batches. The watermark only moves
 * past what was actually seen, so nothing in between is skipped.
 */
import type { CognigyApi } from '../cognigy/api.ts';
import type { OdataClient } from '../cognigy/odata.ts';
import type { Store } from '../store/db.ts';
import { agentRunRequest, resolveEndpoints } from '../agents/service.ts';
import { executeRun } from '../scoring/run.ts';
import { evaluateAlerts } from '../alerts/engine.ts';
import { deliverAlert, type Notifier } from '../alerts/deliver.ts';
import { reconstruct } from '../traces/reconstruct.ts';
import { checkSession, checkToolCalls } from '../checks/exact.ts';
import type { Turn } from '../cognigy/transcript.ts';
import { agentRubrics } from '../agents/model.ts';
import { normalize } from '../rubrics/model.ts';
import { locateAll, locateKey } from '../scoring/locate.ts';
import { fixedState, withToolLines } from '../scoring/state.ts';
import { Ledger } from '../metering.ts';

/** A session quiet this long is taken to be over. */
export const SETTLE_MINUTES = 10;
/** A brand-new agent looks back this far on its first collection. */
export const FIRST_LOOKBACK_HOURS = 24;
/** Tries at scoring a session before it is left for someone to look at. */
export const MAX_ATTEMPTS = 3;
/** Sessions per collection. A catch-up larger than this continues on the next tick. */
export const BATCH_LIMIT = 200;

export interface CollectDeps {
  api: Pick<CognigyApi, 'endpoints' | 'flows'>;
  odata: OdataClient;
  store: Store;
  notifier?: Notifier;
  appUrl?: string;
  /** How long a session must be quiet before it is scored. Demo mode shortens it. */
  settleMinutes?: number;
}

export interface CollectReport {
  agentId: string;
  /** When the collection ran. */
  at: string;
  from: string;
  watermark: string;
  found: number;
  scored: number;
  deferred: number;
  costUsd: number;
  alertsFired: number;
  /** Sessions whose scoring failed this time; each is retried on later collections. */
  failed: number;
  /** The batch was full, so there is more to catch up on straight away. */
  backlog: boolean;
  warnings: string[];
  error?: string;
}

/**
 * Builds tool call records and checks for sessions scored before they existed,
 * from the logs already stored. Costs no Jev calls, and each session is done
 * once: afterwards it has checks.
 */
export function backfillToolCalls(agentId: string, store: Store): number {
  let rebuilt = 0;
  for (const session of store.sessionsWithoutChecks(agentId)) {
    const traces = store.tracesFor(agentId, session.sessionId);
    const trace = traces.length ? reconstruct(traces) : undefined;
    if (trace) {
      checkToolCalls(trace.toolCalls, trace.tools, trace.lastCallAt);
      store.saveToolCalls(agentId, session.sessionId, trace.toolCalls);
    }
    // Older transcripts carry tool lines of their own; the checks read the conversation alone.
    const turns = (JSON.parse(session.transcript) as Turn[]).filter((turn) => !turn.tool);
    store.setSessionChecks(session.runId, session.sessionId, JSON.stringify(checkSession(turns, trace)));
    rebuilt++;
  }
  return rebuilt;
}

/** Older sessions given pointers per collection: enough to catch up in a few minutes, few enough not to hold collection up. */
export const POINTER_BACKFILL = 10;

/**
 * Finds which message each answer rests on for sessions scored before that was
 * done during scoring (or under an older rule), newest first, a few at a time —
 * so opening an older session doesn't wait on Jev either.
 */
export async function backfillPointers(agentId: string, store: Store, limit = POINTER_BACKFILL): Promise<number> {
  const agent = store.agent(agentId);
  if (!agent) return 0;
  const own = agentRubrics(agent, store.rubrics());
  const byId = new Map(own.map((rubric) => [rubric.id, rubric]));
  let done = 0;
  const failures: string[] = [];
  for (const session of store.agentSessions(agentId)) {
    if (done >= limit) break;
    if (session.error || session.unscoreable || session.transcript === '[]') continue;
    const turns = (JSON.parse(session.transcript) as Turn[]).filter((turn) => !turn.tool);
    const missing = store.latestResults([session.sessionId])
      .map((result) => ({ rubric: byId.get(result.rubricId)!, raw: result.raw }))
      .filter(({ rubric, raw }) => rubric && normalize(rubric, rubric.type === 'choice' ? raw : Number(raw)) !== undefined)
      .filter(({ rubric, raw }) => !store.locateFor(agentId, session.sessionId, rubric.id, locateKey(rubric, raw, turns)));
    if (missing.length === 0) continue;
    const traces = store.tracesFor(agentId, session.sessionId);
    const trace = traces.length ? reconstruct(traces) : undefined;
    try {
      const found = await locateAll(missing, withToolLines(turns, trace), fixedState(trace), new Ledger(), session.sessionId);
      for (const { rubric, raw } of missing) {
        const located = found.get(rubric.id);
        if (located) store.saveLocate(agentId, session.sessionId, rubric.id, { ...located, key: locateKey(rubric, raw, turns) });
      }
    } catch (error) {
      // One session Jev couldn't answer for must not stall every session behind it; it's tried again next time.
      failures.push(`${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    done++;
  }
  if (failures.length) throw new Error(`${failures.length} session(s) failed: ${failures[0]}`);
  return done;
}

export async function collectAgent(agentId: string, deps: CollectDeps, now: Date = new Date()): Promise<CollectReport> {
  const { store } = deps;
  const stored = store.agent(agentId);
  if (!stored) throw new Error(`No agent "${agentId}"`);
  const state = store.agentState(agentId);
  const from = state.watermark ?? new Date(now.getTime() - FIRST_LOOKBACK_HOURS * 3_600_000).toISOString();
  const settledBefore = new Date(now.getTime() - (deps.settleMinutes ?? SETTLE_MINUTES) * 60_000).toISOString();
  const report: CollectReport = {
    agentId, at: now.toISOString(), from, watermark: from, found: 0, scored: 0, deferred: 0, costUsd: 0, alertsFired: 0, failed: 0, backlog: false, warnings: [],
  };

  try {
    let agent = stored;
    try {
      ({ agent, warnings: report.warnings } = await resolveEndpoints(stored, deps.api, store));
    } catch (error) {
      report.warnings.push(`could not re-read endpoints: ${error instanceof Error ? error.message : String(error)}`);
    }

    backfillToolCalls(agentId, store);
    const rubrics = store.rubrics();
    const retrySessionIds = store.failedSessions(agentId)
      .filter((failure) => failure.attempts < MAX_ATTEMPTS)
      .map((failure) => failure.sessionId);
    const outcome = await executeRun(
      {
        ...agentRunRequest(agent, rubrics, { from, to: now.toISOString(), limit: BATCH_LIMIT, settledBefore, oldestFirst: true }),
        retrySessionIds,
      },
      { odata: deps.odata, store, rubrics },
    );
    report.found = outcome.found.length;
    report.scored = outcome.scored.length;
    report.failed = outcome.failed.length;
    report.deferred = outcome.deferred.length;
    report.costUsd = outcome.ledger.totals().costUsd;

    // A full batch means sessions may remain unseen after the last one returned,
    // so the watermark stops there rather than jumping to now.
    // So does a discovery that stopped at its record cap: long calls can fill
    // twenty thousand records with fewer sessions than the batch holds.
    report.backlog = outcome.found.length >= BATCH_LIMIT || outcome.truncated;
    const candidate = report.backlog && outcome.found.length
      ? [outcome.found.at(-1)!.startedAt, settledBefore].sort()[0]
      : settledBefore;
    report.watermark = candidate > from ? candidate : from;

    try {
      await backfillPointers(agentId, store);
    } catch (error) {
      // A convenience for reviewers; it never fails a collection.
      report.warnings.push(`could not find messages for older sessions: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Alerts normally look back a fixed span; a catch-up after a long gap must
    // reach back to the oldest day it just scored, or those alerts never fire.
    const oldest = outcome.scored.map((session) => session.startedAt).sort()[0];
    const since = oldest ? `${new Date(oldest).toISOString().slice(0, 10)}T00:00:00.000Z` : undefined;
    for (const event of evaluateAlerts(agent, rubrics, store, now, since)) {
      if (!event.fired) continue;
      await deliverAlert(event.alert, event.rubric, agent, event.late, store, deps.notifier, deps.appUrl);
      report.alertsFired++;
    }
    store.saveAgentState({ agentId, watermark: report.watermark, lastCollectedAt: now.toISOString(), lastError: null });
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    // The watermark does not move on failure: the next attempt retries the same span.
    store.saveAgentState({ agentId, watermark: state.watermark, lastCollectedAt: now.toISOString(), lastError: report.error });
  }
  return report;
}
