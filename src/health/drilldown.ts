/**
 * The lists behind drilling down from an agent: every session it has, and every
 * session one rubric was asked about, with what Jev answered.
 *
 * Numbers go out labelled. A yes/no answer carries the probability of the
 * answer given — "no" with P(yes) 0.42 is "no, probability 0.58" — and a score
 * or choice carries Jev's confidence in the option it picked.
 */
import { agentRubrics, type Agent } from '../agents/model.ts';
import type { SessionChecks } from '../checks/exact.ts';
import type { Rubric } from '../rubrics/model.ts';
import { locateKey, verdictText, type Located } from '../scoring/locate.ts';
import type { Store } from '../store/db.ts';
import { scoreSessions, type ScoredResult } from '../store/score.ts';
import { computeHealth, PASS_AT, WINDOW_DAYS, type HealthWindow } from './health.ts';

type DrillStore = Pick<Store, 'agentSessions' | 'latestResults' | 'locatesForRubric' | 'sessionRows' | 'validityReports' | 'alerts'>;

export type SessionFilter = 'all' | 'rubric_failed' | 'call_failed' | 'not_scored';
export type VerdictFilter = 'failed' | 'passed' | 'all';

export interface Certainty {
  label: 'probability' | 'confidence';
  value: number;
}

export interface SessionListItem {
  sessionId: string;
  startedAt: string;
  /** 0–1, from the agent's rubrics and weights; undefined when nothing scored. */
  score?: number;
  failedRubrics: { id: string; name: string }[];
  failedCalls: number;
  error: string | null;
  unscoreable: string | null;
}

export interface RubricSession {
  sessionId: string;
  startedAt: string;
  raw: string;
  /** Jev's answer in words: yes, no, a score level, a choice. */
  answer: string;
  passed: boolean | null;
  certainty: Certainty | null;
  /** Which agent message the answer rests on, once asked. */
  located?: Located & { quote?: string };
}

/** How sure Jev was of the answer it gave, labelled for what the number is. */
export function certaintyOf(rubric: Rubric, result: Pick<ScoredResult, 'raw' | 'confidence'>): Certainty | null {
  if (rubric.type === 'boolean') {
    const yes = Number(result.raw);
    return { label: 'probability', value: yes >= 0.5 ? yes : 1 - yes };
  }
  return result.confidence === null ? null : { label: 'confidence', value: result.confidence };
}

function since(window: HealthWindow, now: Date): string {
  return new Date(now.getTime() - WINDOW_DAYS[window] * 86_400_000).toISOString();
}

const passes = (result: ScoredResult | undefined) =>
  result?.normalized === undefined ? null : result.normalized >= PASS_AT;

export function sessionList(
  agent: Agent, rubrics: Rubric[], store: DrillStore, window: HealthWindow, show: SessionFilter, now = new Date(),
): { counts: Record<SessionFilter, number>; sessions: SessionListItem[] } {
  const own = agentRubrics(agent, rubrics);
  const rows = store.agentSessions(agent.id, since(window, now));
  const scored = scoreSessions(rows, store.latestResults(rows.map((row) => row.sessionId)), own);
  // Scored as the health figure scores them — weight × validity — so a session's
  // number here is the one health counted.
  const scores = computeHealth(agent, rubrics, store, window, now).sessionScores;
  const items: SessionListItem[] = scored.map(({ session, results }) => ({
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    ...(scores[session.sessionId] !== undefined ? { score: scores[session.sessionId] } : {}),
    failedRubrics: own.filter((rubric) => passes(results.get(rubric.id)) === false).map((rubric) => ({ id: rubric.id, name: rubric.name })),
    failedCalls: session.checks ? (JSON.parse(session.checks) as SessionChecks).failedCalls : 0,
    error: session.error ?? null,
    unscoreable: session.unscoreable,
  }));
  const test: Record<SessionFilter, (item: SessionListItem) => boolean> = {
    all: () => true,
    rubric_failed: (item) => item.failedRubrics.length > 0,
    call_failed: (item) => item.failedCalls > 0,
    not_scored: (item) => Boolean(item.error || item.unscoreable),
  };
  const counts = Object.fromEntries(Object.entries(test).map(([key, fn]) => [key, items.filter(fn).length])) as Record<SessionFilter, number>;
  return { counts, sessions: items.filter(test[show]) };
}

export function rubricSessions(
  agent: Agent, rubric: Rubric, store: DrillStore, window: HealthWindow, show: VerdictFilter, now = new Date(),
): { counts: Record<VerdictFilter, number>; sessions: RubricSession[]; hasVerdicts: boolean } {
  const rows = store.agentSessions(agent.id, since(window, now));
  const scored = scoreSessions(rows, store.latestResults(rows.map((row) => row.sessionId)), [rubric]);
  const located = store.locatesForRubric(agent.id, rubric.id);
  const items: RubricSession[] = [];
  for (const { session, results } of scored) {
    const result = results.get(rubric.id);
    if (!result) continue;
    const raw = String(result.raw);
    // A failed attempt may not have read the conversation; quote from the last one that did.
    const transcript = session.transcript !== '[]' ? session.transcript
      : store.sessionRows(agent.id, session.sessionId).find((row) => row.transcript !== '[]')?.transcript ?? '[]';
    const turns = JSON.parse(transcript) as { role: string; text: string; tool?: string }[];
    const stored = located.get(session.sessionId);
    const pointer = stored?.key === locateKey(rubric, raw, turns.filter((turn) => !turn.tool) as never) ? stored : undefined;
    // Messages are numbered per speaker, the same with or without tool lines, so the quote is found by number.
    const speaker = pointer?.about === 'customer' ? 'user' : 'agent';
    const spoken = pointer && pointer.turnIndex !== null ? turns.filter((turn) => turn.role === speaker) : undefined;
    items.push({
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      raw,
      answer: verdictText(rubric, raw),
      passed: passes(result),
      certainty: certaintyOf(rubric, result),
      ...(pointer ? { located: { ...pointer, ...(spoken ? { quote: spoken[pointer.message! - 1]?.text } : {}) } } : {}),
    });
  }
  // Failures first, then newest: the order you'd read them in.
  items.sort((a, b) => Number(a.passed !== false) - Number(b.passed !== false) || b.startedAt.localeCompare(a.startedAt));
  const counts = {
    failed: items.filter((item) => item.passed === false).length,
    passed: items.filter((item) => item.passed === true).length,
    all: items.length,
  };
  const keep = show === 'all' ? () => true : show === 'failed' ? (item: RubricSession) => item.passed === false : (item: RubricSession) => item.passed === true;
  // A choice rubric whose options carry no pass or fail reports answers only.
  return { counts, sessions: items.filter(keep), hasVerdicts: items.some((item) => item.passed !== null) };
}
