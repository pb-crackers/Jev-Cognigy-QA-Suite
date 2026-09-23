/**
 * What Cognigy sends when an AI Agent or LLM Prompt node has logging on.
 *
 * One POST per LLM call — not per turn. A turn in which the model calls a tool
 * is two calls: one that returns the tool call, and one, with the tool's result
 * in its history, that returns the reply. So a session's traces are stored raw
 * and pieced back together by `sessionId` and `inputId`.
 */

export interface TracePayload {
  meta: {
    timestamp: string;
    sessionId: string;
    inputId?: string;
    userId?: string;
    projectId?: string;
    URLToken?: string;
    requestType?: string;
    status?: string;
  };
  request?: {
    body?: {
      messages?: TraceMessage[];
      tools?: TraceTool[];
      model?: string;
    };
    baseParams?: { model?: string; providerType?: string };
  };
  response?: {
    result?: string;
    finishReason?: string;
    toolCalls?: TraceToolCall[];
    tokenUsage?: { inputTokens?: number; outputTokens?: number };
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
  function?: { name?: string; arguments?: string };
  name?: string;
  arguments?: string;
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
  return call.function?.arguments ?? call.arguments ?? '';
}
