/**
 * One place that turns a logged LLM call, as Cognigy sent it, into the shape
 * the rest of Agent Watch reads.
 *
 * Cognigy's payload is not uniform. A tool call's `arguments` is a JSON string
 * in the message history but an already-parsed object in `response.toolCalls`;
 * `content` is null on an assistant message that calls a tool; `result` is an
 * empty string, not null, when the response is only tool calls; half the
 * fields are absent on some payloads. Every reader used to cope with that on
 * its own, and one that didn't failed every collection. Now only this file
 * knows the raw shape.
 *
 * Nothing here throws on an unexpected shape. A field of the wrong type is
 * read as absent and reported as drift, naming its path, so a change on
 * Cognigy's side shows up in data health instead of stopping the pipeline.
 */
import type { TracePayload } from './model.ts';

export interface ToolDefinition {
  name: string;
  description: string;
  /** The tool's JSON schema, when the node sent one. */
  parameters?: Record<string, unknown>;
}

export interface NormalisedToolCall {
  id: string;
  name: string;
  /** Parsed arguments, or null when the model produced something that is not a JSON object. */
  args: Record<string, unknown> | null;
  /** The arguments as text, exactly as the model wrote them where that is known. */
  argsRaw: string;
}

export interface NormalisedMessage {
  role: string;
  content: string;
  toolCalls: NormalisedToolCall[];
  toolCallId?: string;
}

export interface LlmCall {
  traceId?: string;
  sessionId: string;
  inputId?: string;
  at: string;
  status?: string;
  requestType?: string;
  streamed?: boolean;
  provider?: string;
  /** The model as configured on the node. */
  model?: string;
  /** The dated version the provider actually ran, when it said. */
  modelVersion?: string;
  systemPrompt?: string;
  tools: ToolDefinition[];
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  /** Every message sent except the system prompt, in order. */
  history: NormalisedMessage[];
  /** Text the model returned. Alongside tool calls, it is what the agent said before calling. */
  reply: string;
  finishReason?: string;
  toolCalls: NormalisedToolCall[];
  tokens: { input: number; output: number };
  /**
   * Approximate time the model took: when Cognigy logged the call, less when the
   * provider started its response. Whole seconds on the provider's side and a
   * different clock, so a rough figure only.
   */
  latencyMs?: number;
}

export interface DriftWarning {
  path: string;
  /** What was expected there. */
  expected: string;
  /** What arrived instead. */
  got: string;
}

/** Finish reasons we know how to read. Anything else is reported, not guessed at. */
const FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter', 'function_call']);

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

class Reader {
  readonly drift: DriftWarning[] = [];

  /** The value if it has one of the expected types; otherwise undefined, with drift recorded when present. */
  read<T>(value: unknown, path: string, ...types: string[]): T | undefined {
    if (value === undefined) return undefined;
    if (types.includes(typeName(value))) return value as T;
    this.drift.push({ path, expected: types.join(' or '), got: typeName(value) });
    return undefined;
  }

  string(value: unknown, path: string): string | undefined {
    return this.read<string>(value, path, 'string');
  }

  /** Text that may legitimately be null or empty — read as '' either way. */
  text(value: unknown, path: string): string {
    return this.read<string>(value, path, 'string', 'null') ?? '';
  }

  array(value: unknown, path: string): unknown[] {
    return this.read<unknown[]>(value, path, 'array') ?? [];
  }

  object(value: unknown, path: string): Record<string, unknown> | undefined {
    return this.read<Record<string, unknown>>(value, path, 'object');
  }

  number(value: unknown, path: string): number | undefined {
    return this.read<number>(value, path, 'number');
  }
}

function toolCall(reader: Reader, value: unknown, path: string): NormalisedToolCall | undefined {
  const call = reader.object(value, path);
  if (!call) return undefined;
  // OpenAI-compatible providers nest name and arguments under `function`; the flat form is accepted too.
  const fn = reader.object(call.function, `${path}.function`) ?? call;
  const name = reader.string(fn.name, `${path}.function.name`) ?? 'unknown_tool';
  const id = reader.string(call.id, `${path}.id`) ?? '';
  const raw = reader.read<string | Record<string, unknown>>(fn.arguments, `${path}.function.arguments`, 'string', 'object');
  if (raw === undefined) return { id, name, args: {}, argsRaw: '' };
  if (typeof raw !== 'string') return { id, name, args: raw, argsRaw: JSON.stringify(raw) };
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    return { id, name, args, argsRaw: raw };
  } catch {
    // The model wrote arguments that are not JSON. That is the agent's failure,
    // not drift: kept as written for the checks to flag.
    return { id, name, args: null, argsRaw: raw };
  }
}

function toolCalls(reader: Reader, value: unknown, path: string): NormalisedToolCall[] {
  return reader.array(value, path)
    .map((item, index) => toolCall(reader, item, `${path}[${index}]`))
    .filter((call): call is NormalisedToolCall => Boolean(call));
}

export function normalise(payload: TracePayload): { call: LlmCall; drift: DriftWarning[] } {
  const reader = new Reader();
  const meta = (payload.meta ?? {}) as unknown as Record<string, unknown>;
  const request = reader.object(payload.request, 'request') ?? {};
  const body = reader.object(request.body, 'request.body') ?? {};
  const baseParams = reader.object(request.baseParams, 'request.baseParams') ?? {};
  const response = reader.object(payload.response, 'response') ?? {};
  const usage = reader.object(response.tokenUsage, 'response.tokenUsage') ?? {};
  const lastChunk = reader.object(response.lastChunk, 'response.lastChunk') ?? {};

  let systemPrompt: string | undefined;
  const history: NormalisedMessage[] = [];
  reader.array(body.messages, 'request.body.messages').forEach((value, index) => {
    const path = `request.body.messages[${index}]`;
    const message = reader.object(value, path);
    if (!message) return;
    const role = reader.string(message.role, `${path}.role`) ?? 'unknown';
    const content = reader.text(message.content, `${path}.content`);
    if (role === 'system') {
      if (content.trim()) systemPrompt = content;
      return;
    }
    history.push({
      role,
      content,
      toolCalls: toolCalls(reader, message.tool_calls, `${path}.tool_calls`),
      ...(typeof message.tool_call_id === 'string' ? { toolCallId: message.tool_call_id } : {}),
    });
  });

  const tools: ToolDefinition[] = [];
  reader.array(body.tools, 'request.body.tools').forEach((value, index) => {
    const path = `request.body.tools[${index}]`;
    const tool = reader.object(value, path);
    const fn = tool && (reader.object(tool.function, `${path}.function`) ?? tool);
    const name = fn && reader.string(fn.name, `${path}.function.name`);
    if (!fn || !name) return;
    const parameters = reader.object(fn.parameters, `${path}.function.parameters`);
    tools.push({ name, description: reader.text(fn.description, `${path}.function.description`), ...(parameters ? { parameters } : {}) });
  });

  const finishReason = reader.string(response.finishReason, 'response.finishReason');
  if (finishReason && !FINISH_REASONS.has(finishReason)) {
    reader.drift.push({ path: 'response.finishReason', expected: [...FINISH_REASONS].join(', '), got: finishReason });
  }

  const at = reader.string(meta.timestamp, 'meta.timestamp') ?? '';
  const created = reader.number(lastChunk.created, 'response.lastChunk.created');
  const latencyMs = created && at ? Date.parse(at) - created * 1000 : undefined;

  const call: LlmCall = {
    sessionId: reader.string(meta.sessionId, 'meta.sessionId') ?? '',
    at,
    traceId: reader.string(meta.traceId, 'meta.traceId'),
    inputId: reader.string(meta.inputId, 'meta.inputId'),
    status: reader.string(meta.status, 'meta.status'),
    requestType: reader.string(meta.requestType, 'meta.requestType'),
    streamed: reader.read<boolean>(meta.streamed, 'meta.streamed', 'boolean'),
    provider: reader.string(response.provider, 'response.provider') ?? reader.string(baseParams.providerType, 'request.baseParams.providerType'),
    model: reader.string(baseParams.model, 'request.baseParams.model') ?? reader.string(body.model, 'request.body.model'),
    modelVersion: reader.string(lastChunk.model, 'response.lastChunk.model'),
    systemPrompt,
    tools,
    toolChoice: body.tool_choice,
    parallelToolCalls: reader.read<boolean>(body.parallel_tool_calls, 'request.body.parallel_tool_calls', 'boolean'),
    history,
    reply: reader.text(response.result, 'response.result'),
    finishReason,
    toolCalls: toolCalls(reader, response.toolCalls, 'response.toolCalls'),
    tokens: {
      input: reader.number(usage.inputTokens, 'response.tokenUsage.inputTokens') ?? 0,
      output: reader.number(usage.outputTokens, 'response.tokenUsage.outputTokens') ?? 0,
    },
    // A negative or absurd figure means the clocks disagree, not that the model was instant.
    ...(latencyMs !== undefined && latencyMs >= 0 && latencyMs < 600_000 ? { latencyMs } : {}),
  };
  return { call, drift: reader.drift };
}
