/**
 * What a rubric is.
 *
 * A rubric's `type` chooses the Jev primitive that answers it. Its `combine`
 * mode says how to fold results when a transcript was too long for one request —
 * which depends on what the rubric means, not on its type, so it is stored
 * per rubric rather than derived.
 *
 * Normalisation is kept separate from the raw answer. The model is never asked
 * for a composite grade; it reports a raw result, and the mapping from that to
 * a 0-1 contribution lives here so weights and polarity can change without
 * re-scoring anything.
 */
export type RubricType = 'boolean' | 'score' | 'choice';

/**
 * How to fold per-chunk results for one rubric.
 * - `any`  — a violation anywhere counts. Averaging would hide it.
 * - `last` — the end of the conversation settles it, as with resolution.
 * - `mean` — a prevalence measure, weighted by chunk length.
 */
export type Combine = 'any' | 'last' | 'mean';

export interface Rubric {
  id: string;
  name: string;
  /** The question put to the model. */
  question: string;
  type: RubricType;
  combine: Combine;
  /** Relative importance in the composite score. */
  weight: number;
  enabled: boolean;

  /** `boolean`: what each side means, which sharpens the boundary. */
  trueMeans?: string;
  falseMeans?: string;
  /**
   * When true, a high answer is the bad outcome — as in "agent strayed from
   * instructions" or a frustration level. Applies to `boolean` and `score`.
   */
  invert?: boolean;

  /** `score`: ordered level descriptions, lowest first. At least two. */
  levels?: string[];

  /** `choice`: option key to description. */
  options?: Record<string, string>;
  /** `choice`: 0-1 goodness per option key, for the composite score. */
  optionScores?: Record<string, number>;
}

/**
 * How to fold a rubric's per-chunk results, derived rather than asked.
 *
 * Splitting only happens on very long transcripts, and choosing the fold is an
 * implementation detail no author should have to reason about. The rule follows
 * from what the rubric already declares:
 *
 * - a violation you are trying to catch counts if it happened **anywhere**,
 *   which is the case a mean would quietly destroy — 0.95 alongside two 0.02s
 *   averages to 0.33 and the breach vanishes;
 * - a yes/no or categorical outcome is settled by the **end** of the
 *   conversation, since an early chunk correctly says "not yet";
 * - a graded quality is a property of the conversation as a whole, so it is
 *   **averaged**, weighted by chunk length.
 */
export function inferCombine(rubric: Pick<Rubric, 'type' | 'invert'>): Combine {
  if (rubric.type === 'boolean') return rubric.invert ? 'any' : 'last';
  if (rubric.type === 'choice') return 'last';
  return 'mean';
}

/**
 * Maps a raw answer to a 0-1 contribution. Returns undefined when the rubric
 * carries no opinion about goodness, so it is reported but not scored.
 */
export function normalize(rubric: Rubric, raw: number | string): number | undefined {
  if (rubric.type === 'boolean') {
    const yes = Number(raw);
    return rubric.invert ? 1 - yes : yes;
  }
  if (rubric.type === 'score') {
    const levels = rubric.levels?.length ?? 0;
    if (levels < 2) return undefined;
    const scaled = Math.min(1, Math.max(0, Number(raw) / (levels - 1)));
    return rubric.invert ? 1 - scaled : scaled;
  }
  return rubric.optionScores?.[String(raw)];
}

/** Highest raw value a rubric can report, for display. */
export function scaleOf(rubric: Rubric): number | undefined {
  return rubric.type === 'score' ? (rubric.levels?.length ?? 1) - 1 : undefined;
}
