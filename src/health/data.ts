/**
 * Whether an agent's scores can be trusted: what they rest on, and what went
 * wrong getting there.
 *
 * Health says how the agent is doing; this says how much of that to believe.
 * A session that couldn't be scored, a payload that arrived in a shape nobody
 * has seen, a transcript missing turns the logs know about — each quietly
 * weakens the figure, so each is counted and shown rather than absorbed.
 */
import type { SessionChecks } from '../checks/exact.ts';
import type { Store } from '../store/db.ts';
import { WINDOW_DAYS, type HealthWindow } from './health.ts';

export interface DataHealth {
  sessions: number;
  /** Sessions by how much of their agent output has a logged LLM call. */
  logged: { full: number; partial: number; none: number };
  failed: { count: number; latest: { sessionId: string; error: string; attempts: number }[] };
  unscoreable: number;
  drift: { sessions: number; paths: string[] };
  gaps: { sessions: number; sessionIds: string[] };
  /** Tool calls with at least one failed exact check. Agent behaviour, not data quality — kept apart from `problems`. */
  failedCalls: number;
  /** Things that make the scores less trustworthy: failures, drift, missing turns. */
  problems: number;
}

export function computeDataHealth(
  agentId: string,
  store: Pick<Store, 'agentSessions'>,
  window: HealthWindow,
  now: Date = new Date(),
): DataHealth {
  const since = new Date(now.getTime() - WINDOW_DAYS[window] * 86_400_000).toISOString();
  const sessions = store.agentSessions(agentId, since);
  const out: DataHealth = {
    sessions: sessions.length,
    logged: { full: 0, partial: 0, none: 0 },
    failed: { count: 0, latest: [] },
    unscoreable: 0,
    drift: { sessions: 0, paths: [] },
    gaps: { sessions: 0, sessionIds: [] },
    failedCalls: 0,
    problems: 0,
  };
  const paths = new Set<string>();

  for (const session of sessions) {
    if (session.error) {
      out.failed.count++;
      if (out.failed.latest.length < 3) out.failed.latest.push({ sessionId: session.sessionId, error: session.error, attempts: session.attempts ?? 1 });
      continue;
    }
    if (session.unscoreable) out.unscoreable++;
    out.logged[session.traceCoverage ?? 'none']++;
    if (!session.checks) continue;
    const checks = JSON.parse(session.checks) as SessionChecks;
    if (checks.drift > 0) {
      out.drift.sessions++;
      for (const path of checks.driftPaths ?? []) paths.add(path);
    }
    if (checks.transcriptGaps.length) {
      out.gaps.sessions++;
      out.gaps.sessionIds.push(session.sessionId);
    }
    out.failedCalls += checks.failedCalls;
  }
  out.drift.paths = [...paths];
  out.problems = out.failed.count + out.drift.sessions + out.gaps.sessions;
  return out;
}
