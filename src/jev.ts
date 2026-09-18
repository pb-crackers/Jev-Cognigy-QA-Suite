/**
 * The single instrumented entry point to Jev. Every call in the system goes
 * through `ask`, so timing, token usage, cost and the request/response payload
 * are captured in one place rather than at each call site.
 */
import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { jevCost, type Ledger, type Stage } from './metering.ts';
import { logCall } from './log.ts';

/**
 * Pinned rather than `jev-latest`: an alias moves when a release ships, and
 * recorded cost and latency numbers have to stay attributable to a version.
 */
export const MODEL = 'jev-1.13.0';

/**
 * Constructed on first use, not at import. The SDK throws when no API key is
 * present, and the deterministic unit tests import this module's siblings
 * without one.
 */
let client: TypeSafeClient | undefined;

function jev(): TypeSafeClient {
  client ??= new TypeSafeClient({ defaultModel: MODEL, timeout: 15_000 });
  return client;
}

/** Lowest confidence among the choice/score answers, or undefined for all-noul calls. */
function minConfidence(answers: Record<string, unknown>): number | undefined {
  const scores = Object.values(answers)
    .map((a) => (a as { confidence?: number }).confidence)
    .filter((c): c is number => typeof c === 'number');
  return scores.length ? Math.min(...scores) : undefined;
}

export interface AskOptions<Q extends Questions> {
  stage: Stage;
  label: string;
  state: unknown;
  questions: Q;
  ledger: Ledger;
  sessionId: string;
}

/**
 * One Jev request. Errors are left to propagate — a failed decision must not be
 * silently turned into a default answer — but the failure is still logged and
 * metered so a timeout shows up in the latency record.
 */
export async function ask<Q extends Questions>(
  options: AskOptions<Q>,
): Promise<SystemOneResult<Q>> {
  const { stage, label, state, questions, ledger, sessionId } = options;
  const request = { state, questions, model: MODEL };
  const startedAt = Date.now();

  try {
    const result = await jev().systemOne(request as never) as SystemOneResult<Q>;
    const ms = Date.now() - startedAt;
    const costUsd = jevCost(result.usage.input_tokens);

    const record = ledger.add({
      stage,
      label,
      model: result.model,
      decisions: Object.keys(questions).length,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      ms,
      costUsd,
      minConfidence: minConfidence(result.answers as Record<string, unknown>),
    });

    void logCall({ ...record, ts: new Date().toISOString(), sessionId, request, response: result });
    return result;
  } catch (error) {
    const ms = Date.now() - startedAt;
    const record = ledger.add({
      stage,
      label: `${label} (failed)`,
      model: MODEL,
      decisions: 0,
      inputTokens: 0,
      outputTokens: 0,
      ms,
      costUsd: 0,
    });
    void logCall({
      ...record,
      ts: new Date().toISOString(),
      sessionId,
      request,
      response: { error: String(error) },
    });
    throw error;
  }
}
