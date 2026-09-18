/**
 * Splitting a transcript that will not fit in one request.
 *
 * Jev's binding limit is `state + the longest single question <= 32k tokens`.
 * There is no public tokeniser, so the budget is estimated from character count
 * and deliberately conservative. Every response reports `input_tokens`, so the
 * estimate can be calibrated against reality over time — and a request that
 * overshoots returns a 422, which the caller treats as "split smaller and retry"
 * rather than as a failure. This is a known approximation, not a solved problem.
 */
import type { Turn } from '../cognigy/transcript.ts';

/** Conservative characters-per-token ratio for English conversation. */
const CHARS_PER_TOKEN = 3.5;
/** Hard ceiling for state plus the longest question. */
const STATE_TOKEN_LIMIT = 32_000;
/** Headroom for the estimate being wrong and for the question block. */
const SAFETY_FRACTION = 0.7;
/** Turns repeated across a boundary so a judgement never straddles a cut. */
const OVERLAP_TURNS = 2;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Token budget available to the transcript itself. */
export function stateBudget(questionTokens: number): number {
  return Math.floor(STATE_TOKEN_LIMIT * SAFETY_FRACTION) - questionTokens;
}

function turnCost(turn: Turn): number {
  // The rendered line carries a speaker prefix, so cost it with a little slack.
  return estimateTokens(turn.text) + 6;
}

/**
 * Splits turns into chunks that each fit the budget, cutting only between turns
 * and repeating a couple of turns across each boundary for continuity.
 *
 * Returns a single chunk when the whole transcript fits, which is the normal case.
 */
export function chunkTurns(turns: Turn[], budget: number): Turn[][] {
  const total = turns.reduce((sum, turn) => sum + turnCost(turn), 0);
  if (total <= budget || turns.length <= 1) return [turns];

  const chunks: Turn[][] = [];
  let current: Turn[] = [];
  let cost = 0;

  for (const turn of turns) {
    const thisCost = turnCost(turn);

    if (current.length > 0 && cost + thisCost > budget) {
      chunks.push(current);
      // Carry the tail forward so the next chunk has some context.
      current = current.slice(-OVERLAP_TURNS);
      cost = current.reduce((sum, item) => sum + turnCost(item), 0);
    }

    current.push(turn);
    cost += thisCost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
