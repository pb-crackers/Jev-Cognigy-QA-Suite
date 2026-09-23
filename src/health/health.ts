/**
 * An agent's health: one number a person can report, and what it rests on.
 *
 * Health is the mean composite score of the agent's scored sessions in a
 * window. It earns its meaning three ways:
 *
 * - **Rubrics that have been checked count for more.** Each rubric's weight is
 *   multiplied by its validity — half, until it has been checked — and the
 *   figure says how much of itself rests on verified rubrics.
 * - **It says how sure it is.** A 95% interval comes with it. Jev can answer a
 *   single session differently on a re-ask, but that variation averages out over
 *   many sessions, so the interval narrows as volume grows.
 * - **It says when there is too little to go on.** Below thirty sessions it is
 *   shown as indicative only, not as a health figure.
 *
 * A rubric with no weight — a user's jailbreak attempt — never moves it.
 */
import { agentRubrics, type Agent } from '../agents/model.ts';
import { normalize, type Rubric } from '../rubrics/model.ts';
import type { Store } from '../store/db.ts';
import { UNCHECKED_VALIDITY, type ValidityReport } from '../validity/validity.ts';

export const WINDOW_DAYS = { '24h': 1, '7d': 7, '30d': 30 } as const;
export type HealthWindow = keyof typeof WINDOW_DAYS;
/** Below this, the figure is indicative only. */
export const MIN_SAMPLE = 30;
/** A session scoring below this share of the ideal is listed as failing. */
export const FAILING_BELOW = 0.6;

/** A rubric passes on a session when its value, after polarity, reaches this. Interim, until each rubric says what a pass is. */
export const PASS_AT = 0.5;

export interface RubricHealth {
  rubricId: string;
  name: string;
  kind: 'quality' | 'alert';
  weight: number;
  validity: number;
  verified: boolean;
  answered: number;
  /** Sessions where the rubric passed: its value, after polarity, is at least 0.5. */
  passed: number;
  /** passed ÷ answered — a count, so "91%" means 20 of 22 sessions, not an average score. */
  passRate: number | null;
}

export interface AgentHealth {
  agentId: string;
  window: HealthWindow;
  since: string;
  sessions: number;
  health: number | null;
  /** Half-width of the 95% interval, on the same 0–1 scale. */
  interval: number | null;
  reportable: boolean;
  /** Share of the score's effective weight resting on checked rubrics. */
  verifiedShare: number;
  traced: number;
  alerts: number;
  rubrics: RubricHealth[];
  failing: { sessionId: string; startedAt: string; composite: number; worst: string[] }[];
  trend: { day: string; health: number; sessions: number }[];
}

type HealthStore = Pick<Store, 'agentSessions' | 'latestResults' | 'validityReports' | 'alerts'>;

export function computeHealth(
  agent: Agent,
  rubrics: Rubric[],
  store: HealthStore,
  window: HealthWindow = '24h',
  now: Date = new Date(),
): AgentHealth {
  const since = new Date(now.getTime() - WINDOW_DAYS[window] * 86_400_000).toISOString();
  const collected = store.agentSessions(agent.id, since).filter((session) => !session.unscoreable);
  const results = store.latestResults(collected.map((session) => session.sessionId));
  // A session whose scoring failed has nothing to say about the agent — unless
  // an earlier attempt answered, in which case those answers still stand.
  const answered = new Set(results.map((result) => result.sessionId));
  const sessions = collected.filter((session) => !session.error || answered.has(session.sessionId));
  const validity = store.validityReports<ValidityReport>();
  const own = agentRubrics(agent, rubrics);

  const effective = new Map(own.map((rubric) => {
    const checked = validity.get(rubric.id);
    return [rubric.id, { rubric, validity: checked?.validity ?? UNCHECKED_VALIDITY, verified: Boolean(checked) }];
  }));

  const bySession = new Map<string, Map<string, number>>();
  for (const result of results) {
    const entry = effective.get(result.rubricId);
    if (!entry) continue;
    const value = normalize(entry.rubric, entry.rubric.type === 'choice' ? result.raw : Number(result.raw));
    if (value === undefined) continue;
    const map = bySession.get(result.sessionId) ?? new Map<string, number>();
    map.set(result.rubricId, value);
    bySession.set(result.sessionId, map);
  }

  const composites: { sessionId: string; startedAt: string; composite: number; values: Map<string, number> }[] = [];
  for (const session of sessions) {
    const values = bySession.get(session.sessionId);
    if (!values) continue;
    let weighted = 0;
    let total = 0;
    for (const [rubricId, value] of values) {
      const entry = effective.get(rubricId)!;
      const weight = entry.rubric.weight * entry.validity;
      if (weight <= 0) continue;
      weighted += value * weight;
      total += weight;
    }
    if (total > 0) composites.push({ sessionId: session.sessionId, startedAt: session.startedAt, composite: weighted / total, values });
  }

  const n = composites.length;
  const mean = n ? composites.reduce((sum, item) => sum + item.composite, 0) / n : null;
  const sd = n > 1 && mean !== null
    ? Math.sqrt(composites.reduce((sum, item) => sum + (item.composite - mean) ** 2, 0) / (n - 1))
    : null;

  const weighed = [...effective.values()].filter((entry) => entry.rubric.weight > 0);
  const totalWeight = weighed.reduce((sum, entry) => sum + entry.rubric.weight * entry.validity, 0);
  const verifiedWeight = weighed.filter((entry) => entry.verified).reduce((sum, entry) => sum + entry.rubric.weight * entry.validity, 0);

  const rubricHealth: RubricHealth[] = [...effective.values()].map(({ rubric, validity: v, verified }) => {
    const values = composites.map((item) => item.values.get(rubric.id)).filter((value): value is number => value !== undefined);
    const passed = values.filter((value) => value >= PASS_AT).length;
    return {
      rubricId: rubric.id, name: rubric.name, kind: rubric.kind ?? 'quality', weight: rubric.weight,
      validity: v, verified, answered: values.length, passed,
      passRate: values.length ? passed / values.length : null,
    };
  });

  const days = new Map<string, number[]>();
  for (const item of composites) {
    const day = new Date(item.startedAt).toISOString().slice(0, 10);
    const list = days.get(day) ?? [];
    list.push(item.composite);
    days.set(day, list);
  }

  return {
    agentId: agent.id,
    window,
    since,
    sessions: n,
    health: mean,
    interval: sd !== null ? (1.96 * sd) / Math.sqrt(n) : null,
    reportable: n >= MIN_SAMPLE,
    verifiedShare: totalWeight > 0 ? verifiedWeight / totalWeight : 0,
    traced: sessions.filter((session) => session.traceCoverage === 'full').length,
    alerts: store.alerts({ agentId: agent.id, since }).length,
    rubrics: rubricHealth,
    failing: composites
      .filter((item) => item.composite < FAILING_BELOW)
      .sort((a, b) => a.composite - b.composite)
      .slice(0, 25)
      .map((item) => ({
        sessionId: item.sessionId, startedAt: item.startedAt, composite: item.composite,
        worst: [...item.values].filter(([, value]) => value < 0.5).sort((a, b) => a[1] - b[1]).map(([id]) => id),
      })),
    trend: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => ({
      day, health: list.reduce((a, b) => a + b, 0) / list.length, sessions: list.length,
    })),
  };
}
