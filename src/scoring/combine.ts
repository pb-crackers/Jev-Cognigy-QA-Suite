/**
 * Folding per-chunk results into one result per rubric.
 *
 * Averaging everything would be wrong for most rubrics. "Did the agent ever
 * stray" is true if it happened in any chunk, and averaging hides a single
 * breach. "Was the customer helped" is settled at the end — an early chunk
 * correctly says "not yet", and averaging that in produces a wrong middle
 * answer. Only genuine prevalence measures should be averaged.
 *
 * Confidence folds as the minimum: the weakest judgement behind a result is what
 * should be reported, not the average of strong and weak ones.
 */
import type { Combine, Rubric } from '../rubrics/model.ts';

export interface ChunkAnswer {
  /** Noul probability, score value, or chosen option key. */
  raw: number | string;
  /** Absent for noul answers, which carry no confidence. */
  confidence?: number;
  /** Turn count, used to weight a mean. */
  weight: number;
}

export interface CombinedAnswer {
  raw: number | string;
  confidence?: number;
  /** How many chunks contributed. */
  chunks: number;
  /** Which chunk decided it, for `any` and `last`. */
  decidedBy?: number;
}

function foldConfidence(answers: ChunkAnswer[]): number | undefined {
  const values = answers.map((a) => a.confidence).filter((c): c is number => c !== undefined);
  return values.length ? Math.min(...values) : undefined;
}

export function combineAnswers(rubric: Rubric, answers: ChunkAnswer[]): CombinedAnswer {
  if (answers.length === 0) throw new Error(`No answers to combine for "${rubric.name}"`);
  if (answers.length === 1) {
    return { raw: answers[0].raw, confidence: answers[0].confidence, chunks: 1 };
  }

  const mode: Combine = rubric.combine;
  const confidence = foldConfidence(answers);

  if (mode === 'last') {
    const last = answers.length - 1;
    return { raw: answers[last].raw, confidence, chunks: answers.length, decidedBy: last };
  }

  if (mode === 'any') {
    // "Any" means the most alarming reading wins. For a boolean that is the
    // highest probability; for a graded rubric it is the worst level, which
    // depends on which direction is bad.
    if (rubric.type === 'choice') {
      const worst = answers.reduce((acc, answer, index) => {
        const accScore = rubric.optionScores?.[String(acc.answer.raw)] ?? 1;
        const thisScore = rubric.optionScores?.[String(answer.raw)] ?? 1;
        return thisScore < accScore ? { answer, index } : acc;
      }, { answer: answers[0], index: 0 });
      return { raw: worst.answer.raw, confidence, chunks: answers.length, decidedBy: worst.index };
    }

    const pickHighest = rubric.type === 'boolean' ? !rubric.invert : false;
    const chosen = answers.reduce((acc, answer, index) => {
      const better = pickHighest
        ? Number(answer.raw) < Number(acc.answer.raw)
        : Number(answer.raw) > Number(acc.answer.raw);
      return better ? { answer, index } : acc;
    }, { answer: answers[0], index: 0 });
    return { raw: chosen.answer.raw, confidence, chunks: answers.length, decidedBy: chosen.index };
  }

  // Mean, weighted by chunk size. A choice has no meaningful average, so the
  // most frequent option stands in.
  if (rubric.type === 'choice') {
    const tally = new Map<string, number>();
    for (const answer of answers) {
      const key = String(answer.raw);
      tally.set(key, (tally.get(key) ?? 0) + answer.weight);
    }
    const [top] = [...tally.entries()].sort(([, a], [, b]) => b - a);
    return { raw: top[0], confidence, chunks: answers.length };
  }

  const totalWeight = answers.reduce((sum, answer) => sum + answer.weight, 0) || 1;
  const mean =
    answers.reduce((sum, answer) => sum + Number(answer.raw) * answer.weight, 0) / totalWeight;
  return { raw: mean, confidence, chunks: answers.length };
}
