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
import type { Modality } from '../cognigy/channels.ts';

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

  /**
   * The only modality this rubric applies to. Absent means every conversation,
   * which is the normal case — a scope is worth setting only when the question
   * is meaningless in the other modality, as "did the agent confirm the
   * spelling" is in a chat window.
   */
  appliesTo?: Modality;

  /**
   * Extra instruction appended to this rubric's question, per modality.
   *
   * This is where modality-specific context belongs rather than in the state.
   * A state field would lean on every rubric in the run whether or not its
   * author wanted it; an instruction here is explicit, authored and visible in
   * the logged request.
   */
  notes?: Partial<Record<Modality, string>>;

  /**
   * Where the rubric came from. Library rubrics ship with the tool and apply to
   * every agent; custom ones are written by the user and are off for an agent
   * until switched on.
   */
  origin?: 'library' | 'custom';

  /**
   * `quality` rubrics say how a conversation could be better. `alert` rubrics
   * say something happened that someone needs to know about now. An alert
   * rubric is a yes/no question where yes means the event happened.
   */
  kind?: 'quality' | 'alert';

  /**
   * When an alert rubric fires: at `threshold` hits within one `window`,
   * bucketed on when the conversations happened rather than when they were
   * collected. A threshold of 1 in a `session` window fires on the first hit.
   */
  alert?: { threshold: number; window: 'session' | 'hour' | 'day' };

  /**
   * What the author needs this rubric to catch, in plain words. Validity checks
   * the wording against it; without it, "is this measuring what we need" has
   * nothing to be checked against.
   */
  intent?: string;

  /**
   * Answerable only with the agent's logged LLM calls — its instructions as
   * sent and its tool calls. Reported as not applicable on a session without
   * full trace coverage rather than answered from a guess.
   */
  requiresTrace?: boolean;
}

/**
 * Whether a rubric should be asked of a conversation of this modality.
 *
 * An unknown modality is asked everything — see `modalityOf`.
 */
export function applies(rubric: Pick<Rubric, 'appliesTo'>, modality: Modality | undefined): boolean {
  return modality === undefined || rubric.appliesTo === undefined || rubric.appliesTo === modality;
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
