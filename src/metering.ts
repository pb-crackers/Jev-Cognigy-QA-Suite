/**
 * Cost and latency accounting.
 *
 * Jev bills input tokens only; output is free. The LLM figures here are computed
 * estimates at published rates, never measured — the UI labels them as such.
 */

/** Jev 1.13: $42 per Btok input, output free. */
export const JEV_INPUT_PER_MTOK = 0.042;

/** Per-Mtok rates. Verified against the Claude API skill, not recalled. */
export const LLM_PRICES = {
  'claude-haiku-4-5': { input: 1, output: 5, label: 'Haiku 4.5' },
  'claude-sonnet-5': { input: 2, output: 10, label: 'Sonnet 5' },
  'claude-opus-5': { input: 5, output: 25, label: 'Opus 5' },
} as const;

export type LlmModel = keyof typeof LLM_PRICES;

/** Cache reads bill at 0.1x input. The cached row is the honest floor for the comparison. */
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Output tokens an LLM would emit to return the same structured decisions Jev
 * returns for free. Deliberately conservative — a real agent emits prose too.
 */
export const ASSUMED_LLM_OUTPUT_TOKENS = 60;

export function jevCost(inputTokens: number): number {
  return (inputTokens / 1_000_000) * JEV_INPUT_PER_MTOK;
}

export interface LlmEstimate {
  model: LlmModel;
  label: string;
  uncachedUsd: number;
  cachedUsd: number;
}

/** What the same token volume would cost on each comparison model. */
export function llmEquivalents(
  inputTokens: number,
  outputTokens: number = ASSUMED_LLM_OUTPUT_TOKENS,
): LlmEstimate[] {
  return (Object.keys(LLM_PRICES) as LlmModel[]).map((model) => {
    const price = LLM_PRICES[model];
    const out = (outputTokens / 1_000_000) * price.output;
    return {
      model,
      label: price.label,
      uncachedUsd: (inputTokens / 1_000_000) * price.input + out,
      cachedUsd: (inputTokens / 1_000_000) * price.input * CACHE_READ_MULTIPLIER + out,
    };
  });
}

/** What produced a call — a scoring pass, or a retry after a re-split. */
export type Stage = 'score' | 'rescore';

export interface CallRecord {
  stage: Stage;
  label: string;
  /** Versioned model id as reported by the response, or `deterministic` for L3. */
  model: string;
  /** How many independent decisions this one call returned. */
  decisions: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  costUsd: number;
  /** Lowest confidence among this call's choice/score answers, when any. */
  minConfidence?: number;
  /** Session this call scored, so cost can be attributed per session. */
  sessionId?: string;
}

export interface Totals {
  calls: number;
  modelCalls: number;
  decisions: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
  avgMs: number;
}

/** Accumulates call records for a session and derives the totals the UI shows. */
export class Ledger {
  readonly records: CallRecord[] = [];

  add(record: CallRecord): CallRecord {
    this.records.push(record);
    return record;
  }

  /** Records added since a marker index — used to report a single turn. */
  since(index: number): CallRecord[] {
    return this.records.slice(index);
  }

  get mark(): number {
    return this.records.length;
  }

  totals(records: CallRecord[] = this.records): Totals {
    const modelCalls = records.filter((r) => r.model !== 'deterministic');
    const ms = records.reduce((sum, r) => sum + r.ms, 0);
    return {
      calls: records.length,
      modelCalls: modelCalls.length,
      decisions: records.reduce((sum, r) => sum + r.decisions, 0),
      inputTokens: records.reduce((sum, r) => sum + r.inputTokens, 0),
      outputTokens: records.reduce((sum, r) => sum + r.outputTokens, 0),
      costUsd: records.reduce((sum, r) => sum + r.costUsd, 0),
      ms,
      avgMs: modelCalls.length
        ? modelCalls.reduce((sum, r) => sum + r.ms, 0) / modelCalls.length
        : 0,
    };
  }
}
