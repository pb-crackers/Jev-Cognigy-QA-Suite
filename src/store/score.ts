/**
 * Composite scoring, applied at read time.
 *
 * The model is never asked for an overall grade. It reports raw per-rubric
 * answers, and this module folds them into a weighted score using whatever
 * weights are current. That is the whole point: a manager changing what
 * compliance is worth re-ranks every historical session instantly, and no
 * request is sent.
 */
import { normalize, type Rubric } from '../rubrics/model.ts';
import type { ResultRow, SessionRow } from './db.ts';

/** Below this, a result is flagged for human review rather than trusted. */
export const REVIEW_CONFIDENCE = 0.6;

export interface ScoredResult {
  rubricId: string;
  raw: number | string;
  /** 0-1 contribution, or undefined when the rubric carries no polarity. */
  normalized?: number;
  confidence: number | null;
  chunks: number;
  decidedBy: number | null;
  lowConfidence: boolean;
}

export interface ScoredSession {
  session: SessionRow;
  results: Map<string, ScoredResult>;
  /** Weighted composite on a 0-5 scale, or undefined when nothing scoreable. */
  composite?: number;
  /** Rubrics whose confidence fell below the review threshold. */
  flagged: string[];
}

function parseRaw(raw: string): number | string {
  const numeric = Number(raw);
  return raw.trim() !== '' && Number.isFinite(numeric) ? numeric : raw;
}

export function scoreSessions(
  sessions: SessionRow[],
  results: ResultRow[],
  rubrics: Rubric[],
): ScoredSession[] {
  const byRubric = new Map(rubrics.map((rubric) => [rubric.id, rubric]));
  const bySession = new Map<string, ResultRow[]>();
  for (const result of results) {
    const list = bySession.get(result.sessionId);
    if (list) list.push(result);
    else bySession.set(result.sessionId, [result]);
  }

  return sessions.map((session) => {
    const rows = bySession.get(session.sessionId) ?? [];
    const scored = new Map<string, ScoredResult>();
    const flagged: string[] = [];

    let weighted = 0;
    let totalWeight = 0;

    for (const row of rows) {
      const rubric = byRubric.get(row.rubricId);
      if (!rubric) continue;

      const raw = parseRaw(row.raw);
      const normalized = normalize(rubric, raw);
      const lowConfidence = row.confidence !== null && row.confidence < REVIEW_CONFIDENCE;
      if (lowConfidence) flagged.push(rubric.id);

      scored.set(row.rubricId, {
        rubricId: row.rubricId,
        raw,
        normalized,
        confidence: row.confidence,
        chunks: row.chunks,
        decidedBy: row.decidedBy,
        lowConfidence,
      });

      if (normalized !== undefined && rubric.enabled) {
        weighted += normalized * rubric.weight;
        totalWeight += rubric.weight;
      }
    }

    return {
      session,
      results: scored,
      composite: totalWeight > 0 ? (weighted / totalWeight) * 5 : undefined,
      flagged,
    };
  });
}
