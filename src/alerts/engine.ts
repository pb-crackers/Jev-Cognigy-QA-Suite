/**
 * Deciding when an alert rubric has fired.
 *
 * An alert rubric is a yes/no question where yes means the event happened. It
 * fires when enough hits land in one window: `{ threshold: 1, window: 'session' }`
 * is "tell me every time", `{ threshold: 10, window: 'day' }` is "tell me if
 * someone keeps at it".
 *
 * Windows are keyed on **when the conversations happened**, never on when they
 * were collected. A laptop that was off for three days collects three days of
 * traffic in one go; bucketing on collection time would pile all of it into one
 * day and trip every rate alert at once.
 *
 * One alert per agent, rubric and window. Later hits in the same window raise
 * its count without notifying again — the first notification already said so.
 */
import { agentRubrics, type Agent } from '../agents/model.ts';
import type { Rubric } from '../rubrics/model.ts';
import type { AlertRow, Store } from '../store/db.ts';

/** How far back an alert is re-evaluated: long enough to cover a day window and a catch-up. */
export const ALERT_LOOKBACK_DAYS = 8;

export function windowKey(window: 'session' | 'hour' | 'day', sessionId: string, happenedAt: string): string {
  if (window === 'session') return `session:${sessionId}`;
  const utc = new Date(happenedAt).toISOString();
  return window === 'hour' ? `hour:${utc.slice(0, 13)}` : `day:${utc.slice(0, 10)}`;
}

/** Yes means it happened. The raw answer is the probability of yes. */
export function isHit(raw: string): boolean {
  return Number(raw) >= 0.5;
}

export interface AlertEvent {
  alert: AlertRow;
  rubric: Rubric;
  /** Newly fired, so it should be delivered. */
  fired: boolean;
  /** Detected more than two collection intervals after it happened. */
  late: boolean;
}

export function evaluateAlerts(
  agent: Agent,
  rubrics: Rubric[],
  store: Pick<Store, 'agentSessions' | 'latestResults' | 'alertFor' | 'insertAlert' | 'updateAlert'>,
  now: Date = new Date(),
): AlertEvent[] {
  const watching = agentRubrics(agent, rubrics).filter((rubric) => rubric.kind === 'alert' && rubric.alert);
  if (watching.length === 0) return [];

  const since = new Date(now.getTime() - ALERT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const sessions = store.agentSessions(agent.id, since);
  const startedAt = new Map(sessions.map((session) => [session.sessionId, session.startedAt]));
  const results = store.latestResults(sessions.map((session) => session.sessionId));

  const events: AlertEvent[] = [];
  for (const rubric of watching) {
    const { threshold, window } = rubric.alert!;
    const buckets = new Map<string, { sessionId: string; at: string }[]>();
    for (const result of results) {
      if (result.rubricId !== rubric.id || !isHit(result.raw)) continue;
      const at = startedAt.get(result.sessionId);
      if (!at) continue;
      const key = windowKey(window, result.sessionId, at);
      const list = buckets.get(key) ?? [];
      list.push({ sessionId: result.sessionId, at });
      buckets.set(key, list);
    }

    for (const [key, hits] of buckets) {
      if (hits.length < threshold) continue;
      hits.sort((a, b) => a.at.localeCompare(b.at));
      const sessionIds = hits.map((hit) => hit.sessionId);
      // It fired when the threshold was reached, not when the window opened.
      const happenedAt = hits[threshold - 1].at;
      const existing = store.alertFor(agent.id, rubric.id, key);
      if (existing) {
        if (hits.length > existing.count) {
          store.updateAlert(existing.id, { count: hits.length, sessions: sessionIds });
          events.push({ alert: { ...existing, count: hits.length, sessions: sessionIds }, rubric, fired: false, late: false });
        }
        continue;
      }
      const detectedAt = now.toISOString();
      const lateAfterMs = 2 * agent.intervalMinutes * 60_000;
      const alert = store.insertAlert({
        agentId: agent.id, rubricId: rubric.id, windowKey: key, happenedAt, detectedAt,
        count: hits.length, sessions: sessionIds, delivered: {},
      });
      events.push({ alert, rubric, fired: true, late: now.getTime() - Date.parse(happenedAt) > lateAfterMs });
    }
  }
  return events;
}
