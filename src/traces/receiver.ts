/**
 * The webhook Cognigy posts each logged LLM call to.
 *
 * The path names the agent — `/hook/<agentId>` — because Agent Watch generates
 * that URL itself when it installs logging, so it is certain. The shared secret
 * in `x-webhook-token` is what proves the caller is the Cognigy node the agent
 * configured and not anyone who guessed the path.
 *
 * It answers fast and does nothing but store: scoring happens on the collector's
 * schedule, and a slow receiver would stall the agent's reply to its customer.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/db.ts';
import { unwrapTrace } from './model.ts';

/** Generous for one LLM call, whose history is re-sent every time; tight enough to refuse abuse. */
export const MAX_TRACE_BYTES = 5 * 1024 * 1024;

export interface HookResult {
  status: number;
  body?: Record<string, unknown>;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function receiveTrace(
  store: Pick<Store, 'agent' | 'saveTrace'>,
  agentId: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
): HookResult {
  const agent = store.agent(agentId);
  if (!agent) return { status: 404, body: { error: 'No such agent' } };

  const header = headers['x-webhook-token'];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token || !sameSecret(token, agent.trace.token)) {
    return { status: 401, body: { error: 'Missing or wrong x-webhook-token' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'Body is not JSON' } };
  }
  const payload = unwrapTrace(parsed);
  if (!payload) return { status: 400, body: { error: 'No meta.sessionId in the payload' } };

  // A retry of a call already stored is still a success for the sender.
  store.saveTrace(agentId, payload);
  return { status: 204 };
}

/**
 * Loads traces captured elsewhere — a single payload, an array, or a relay's
 * stored envelopes — so history from before Agent Watch was listening, or from
 * while the laptop was asleep and a relay was not, can still be graded.
 */
export function importTraces(
  store: Pick<Store, 'agent' | 'saveTrace'>, agentId: string, value: unknown,
): { imported: number; duplicates: number; skipped: number } {
  if (!store.agent(agentId)) throw new Error(`No agent "${agentId}"`);
  const items = Array.isArray(value) ? value : [value];
  let imported = 0;
  let duplicates = 0;
  for (const item of items) {
    const payload = unwrapTrace(item);
    if (!payload) continue;
    if (store.saveTrace(agentId, payload)) imported++;
    else duplicates++;
  }
  return { imported, duplicates, skipped: items.length - imported - duplicates };
}
