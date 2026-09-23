import { createHash } from 'node:crypto';

/**
 * What Cognigy sends when an AI Agent or LLM Prompt node has logging on.
 *
 * One POST per LLM call — not per turn. A turn in which the model calls a tool
 * is two calls: one that returns the tool call, and one, with the tool's result
 * in its history, that returns the reply. So a session's traces are stored raw
 * and pieced back together by `sessionId` and `inputId`.
 */

/**
 * As received. Every field is optional in practice — the one imported relay
 * payload lacks half of these — so nothing here is read directly: `normalise`
 * turns it into an `LlmCall` and reports anything shaped unexpectedly.
 */
export interface TracePayload {
  meta: {
    timestamp: string;
    sessionId: string;
    inputId?: string;
    traceId?: string;
    userId?: string;
    projectId?: string;
    URLToken?: string;
    requestType?: string;
    status?: string;
    streamed?: boolean;
  };
  request?: {
    body?: {
      messages?: TraceMessage[];
      tools?: TraceTool[];
      model?: string;
      tool_choice?: unknown;
      parallel_tool_calls?: boolean;
    };
    baseParams?: { model?: string; providerType?: string };
  };
  response?: {
    result?: string;
    provider?: string;
    finishReason?: string;
    toolCalls?: TraceToolCall[];
    tokenUsage?: { inputTokens?: number; outputTokens?: number };
    lastChunk?: { created?: number; model?: string };
  };
}

export interface TraceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content?: string | null;
  tool_calls?: TraceToolCall[];
  tool_call_id?: string;
}

export interface TraceTool {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

/**
 * A tool call. OpenAI-compatible providers nest the name and arguments under
 * `function`; the flat form is accepted too, since the only real sample so far
 * had no tool calls to confirm which shape Cognigy forwards.
 */
export interface TraceToolCall {
  id?: string;
  type?: string;
  // A JSON string in the message history, but already parsed in `response.toolCalls`.
  function?: { name?: string; arguments?: string | Record<string, unknown> };
  name?: string;
  arguments?: string | Record<string, unknown>;
}

export interface StoredTrace {
  id: number;
  agentId: string;
  sessionId: string;
  inputId: string | null;
  eventAt: string;
  receivedAt: string;
  payload: TracePayload;
}

/**
 * The payload inside whatever arrived.
 *
 * Cognigy posts `{ meta, request, response }`. A webhook relay that stores what
 * it receives wraps that as `{ headers, queryParams, body }` — the shape of the
 * sample the tool was designed from — so importing a relay's export works too.
 * The query string's `sessionId` stands in when `meta` somehow lacks one.
 */
export function unwrapTrace(value: unknown): TracePayload | undefined {
  const record = (value ?? {}) as Record<string, unknown>;
  const inner = (record.body && typeof record.body === 'object' && (record.body as Record<string, unknown>).meta
    ? record.body
    : record) as Partial<TracePayload>;
  const query = (record.queryParams ?? {}) as Record<string, unknown>;
  const meta = inner.meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const sessionId = meta.sessionId || (typeof query.sessionId === 'string' ? query.sessionId : undefined);
  if (!sessionId) return undefined;
  return {
    ...inner,
    meta: { ...meta, sessionId, timestamp: meta.timestamp || new Date().toISOString() },
  } as TracePayload;
}

export function toolCallName(call: TraceToolCall): string {
  return call.function?.name ?? call.name ?? 'unknown_tool';
}

export function toolCallArguments(call: TraceToolCall): string {
  const args = call.function?.arguments ?? call.arguments ?? '';
  return typeof args === 'string' ? args : JSON.stringify(args);
}

/**
 * What makes one logged call that call, so a retried or re-imported delivery is
 * stored once. Not the arrival time: a payload without a timestamp is given one
 * on arrival, and a retry would get a different one. Cognigy's traceId names the
 * user turn, not the call, so the call is pinned by how much history it was sent
 * — each call in a turn is sent more than the last — and what came back.
 */
export function traceKey(payload: TracePayload): string {
  const { sessionId, inputId, traceId } = payload.meta;
  const sent = payload.request?.body?.messages?.length ?? 0;
  const digest = createHash('sha256').update(JSON.stringify(payload.response ?? null)).digest('hex').slice(0, 24);
  return `${sessionId}|${inputId ?? ''}|${traceId ?? ''}|${sent}|${digest}`;
}
