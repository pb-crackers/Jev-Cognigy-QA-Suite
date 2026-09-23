/**
 * A session's logged LLM calls, pieced back into what the grader needs.
 *
 * Three things come out: the agent's instructions exactly as they were sent,
 * the tools it had, and every tool call and tool result in order. Tool calls
 * are read from each response; results from the `tool` messages in later
 * requests' history, matched by call id and taken once — the history repeats
 * them on every subsequent call.
 */
import type { Turn } from '../cognigy/transcript.ts';
import { LLM_NODE_TYPES } from '../agents/nodes.ts';
import type { TraceCoverage } from '../store/db.ts';
import { type StoredTrace, toolCallArguments, toolCallName } from './model.ts';

export interface ToolEvent {
  kind: 'call' | 'result';
  name: string;
  callId?: string;
  /** Arguments for a call, content for a result — both as sent. */
  detail: string;
  inputId: string | null;
  at: string;
}

export interface SessionTrace {
  /** The system prompt from the newest call: the instructions in force at the end. */
  instructions?: string;
  tools: { name: string; description: string }[];
  events: ToolEvent[];
  /** Inputs that have at least one logged LLM call behind them. */
  inputIds: Set<string>;
  calls: number;
  model?: string;
  tokens: { input: number; output: number };
}

export function reconstruct(traces: StoredTrace[]): SessionTrace {
  const ordered = [...traces].sort((a, b) => a.eventAt.localeCompare(b.eventAt));
  const out: SessionTrace = { tools: [], events: [], inputIds: new Set(), calls: ordered.length, tokens: { input: 0, output: 0 } };
  const namesByCall = new Map<string, string>();
  const seenResults = new Set<string>();
  const seenCalls = new Set<string>();

  for (const trace of ordered) {
    const { payload } = trace;
    if (trace.inputId) out.inputIds.add(trace.inputId);
    const messages = payload.request?.body?.messages ?? [];

    const system = messages.find((message) => message.role === 'system')?.content;
    if (typeof system === 'string' && system.trim()) out.instructions = system;

    const tools = payload.request?.body?.tools ?? [];
    if (tools.length) {
      out.tools = tools
        .map((tool) => ({ name: tool.function?.name ?? '', description: tool.function?.description ?? '' }))
        .filter((tool) => tool.name);
    }
    out.model = payload.request?.baseParams?.model ?? payload.request?.body?.model ?? out.model;
    out.tokens.input += payload.response?.tokenUsage?.inputTokens ?? 0;
    out.tokens.output += payload.response?.tokenUsage?.outputTokens ?? 0;

    // Results arrive in the history of the call after the one that asked for them.
    for (const message of messages) {
      if (message.role !== 'tool' || !message.tool_call_id || seenResults.has(message.tool_call_id)) continue;
      seenResults.add(message.tool_call_id);
      out.events.push({
        kind: 'result',
        name: namesByCall.get(message.tool_call_id) ?? 'tool',
        callId: message.tool_call_id,
        detail: String(message.content ?? ''),
        inputId: trace.inputId,
        at: trace.eventAt,
      });
    }

    for (const call of payload.response?.toolCalls ?? []) {
      const key = call.id ?? `${trace.id}:${toolCallName(call)}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      if (call.id) namesByCall.set(call.id, toolCallName(call));
      out.events.push({
        kind: 'call',
        name: toolCallName(call),
        callId: call.id,
        detail: toolCallArguments(call),
        inputId: trace.inputId,
        at: trace.eventAt,
      });
    }
  }

  // A result is recorded against the call that produced it once both are known.
  for (const event of out.events) {
    if (event.kind === 'result' && event.callId) event.name = namesByCall.get(event.callId) ?? event.name;
  }
  out.events.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === 'call' ? -1 : 1));
  return out;
}

/**
 * How much of a session's LLM-produced output has a logged call behind it.
 *
 * Only agent turns from an LLM node count — a Say node never calls a model, so
 * its absence from the traces is not a gap. A turn whose node type is unknown
 * is counted, because assuming it needs no trace would overstate coverage.
 */
export function traceCoverage(turns: Turn[], trace: Pick<SessionTrace, 'inputIds'> | undefined): TraceCoverage {
  if (!trace || trace.inputIds.size === 0) return 'none';
  const needing = turns.filter(
    (turn) => turn.role === 'agent' && (!turn.nodeType || LLM_NODE_TYPES.has(turn.nodeType)),
  );
  if (needing.length === 0) return 'none';
  const covered = needing.filter((turn) => turn.inputId && trace.inputIds.has(turn.inputId)).length;
  if (covered === needing.length) return 'full';
  return covered === 0 ? 'none' : 'partial';
}
