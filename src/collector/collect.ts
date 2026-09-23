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

/** A session quiet this long is taken to be over. */
export const SETTLE_MINUTES = 10;
/** A brand-new agent looks back this far on its first collection. */
export const FIRST_LOOKBACK_HOURS = 24;
/** Sessions per collection. A catch-up larger than this continues on the next tick. */
export const BATCH_LIMIT = 200;

export interface CollectDeps {
  api: Pick<CognigyApi, 'endpoints' | 'flows'>;
  odata: OdataClient;
  store: Store;
  notifier?: Notifier;
  appUrl?: string;
}

export interface CollectReport {
  agentId: string;
  from: string;
  watermark: string;
  found: number;
  scored: number;
  deferred: number;
  costUsd: number;
  alertsFired: number;
  /** The batch was full, so there is more to catch up on straight away. */
  backlog: boolean;
  warnings: string[];
  error?: string;
}

export async function collectAgent(agentId: string, deps: CollectDeps, now: Date = new Date()): Promise<CollectReport> {
  const { store } = deps;
  const stored = store.agent(agentId);
  if (!stored) throw new Error(`No agent "${agentId}"`);
  const state = store.agentState(agentId);
  const from = state.watermark ?? new Date(now.getTime() - FIRST_LOOKBACK_HOURS * 3_600_000).toISOString();
  const settledBefore = new Date(now.getTime() - SETTLE_MINUTES * 60_000).toISOString();
  const report: CollectReport = {
    agentId, from, watermark: from, found: 0, scored: 0, deferred: 0, costUsd: 0, alertsFired: 0, backlog: false, warnings: [],
  };

  try {
    let agent = stored;
    try {
      ({ agent, warnings: report.warnings } = await resolveEndpoints(stored, deps.api, store));
    } catch (error) {
      report.warnings.push(`could not re-read endpoints: ${error instanceof Error ? error.message : String(error)}`);
    }

    const rubrics = store.rubrics();
    const outcome = await executeRun(
      agentRunRequest(agent, rubrics, { from, to: now.toISOString(), limit: BATCH_LIMIT, settledBefore, oldestFirst: true }),
      { odata: deps.odata, store, rubrics },
    );
    report.found = outcome.found.length;
    report.scored = outcome.scored.length;
    report.deferred = outcome.deferred.length;
    report.costUsd = outcome.ledger.totals().costUsd;

    // A full batch means sessions may remain unseen after the last one returned,
    // so the watermark stops there rather than jumping to now.
    report.backlog = outcome.found.length >= BATCH_LIMIT;
    const candidate = report.backlog
      ? [outcome.found.at(-1)!.startedAt, settledBefore].sort()[0]
      : settledBefore;
    report.watermark = candidate > from ? candidate : from;

    for (const event of evaluateAlerts(agent, rubrics, store, now)) {
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
