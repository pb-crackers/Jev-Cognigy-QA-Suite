/**
 * A session's logged LLM calls, pieced back into what the grader and the
 * reviewer need.
 *
 * Out come the agent's instructions exactly as they were sent, the tools it
 * had (with their schemas), and every tool call it made as a record: what it
 * called, with what, what came back, what it said around it, and when.
 *
 * Order comes from the message history, not from timestamps. Each call's
 * history is the previous call's plus what happened since, so the order in
 * which a tool call first appears — in a response, then in the next history —
 * is the order it happened in. Timestamps are kept for timing only: a result
 * is logged with the *next* call's time, the same time as any new call that
 * response makes, and sorting on them put a later call before an earlier
 * result.
 */
import type { Turn } from '../cognigy/transcript.ts';
import { LLM_NODE_TYPES } from '../agents/nodes.ts';
import type { TraceCoverage } from '../store/db.ts';
import type { StoredTrace } from './model.ts';
import { normalise, type DriftWarning, type LlmCall, type NormalisedToolCall, type ToolDefinition } from './normalise.ts';

export type CheckOutcome = 'pass' | 'fail' | 'unchecked';

export interface CheckResult {
  id: string;
  /** What the check asks, in words, as the session view lists it. */
  label: string;
  outcome: CheckOutcome;
  /** What was found, in words — shown beside the verdict. */
  detail?: string;
  /** For the schema check: each problem with the argument it concerns. */
  issues?: { path: string; message: string }[];
}

export interface ToolCallRecord {
  /** Position among the session's tool calls, from 1. */
  seq: number;
  callId: string;
  /** The user input whose reply this call was made for. */
  inputId?: string;
  name: string;
  args: Record<string, unknown> | null;
  argsRaw: string;
  /** The tool as the agent had it when it made the call. */
  definition?: ToolDefinition;
  /** What the tool returned, as text; undefined when no result was ever logged. */
  result?: string;
  /** The result parsed, when it is JSON. */
  resultJson?: unknown;
  /** Text the agent said in the same response as the call — before calling. */
  preamble?: string;
  /** The reply the agent gave for this input once its tools were done. */
  replyAfter?: string;
  calledAt?: string;
  resultAt?: string;
  /** The LLM call that decided to make this tool call. */
  llm?: { model?: string; modelVersion?: string; finishReason?: string; tokens: { input: number; output: number }; latencyMs?: number };
  checks: CheckResult[];
}

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
  tools: ToolDefinition[];
  toolCalls: ToolCallRecord[];
  /** Tool calls and results as a flat sequence, in the order they happened. */
  events: ToolEvent[];
  /** Inputs that have at least one logged LLM call behind them. */
  inputIds: Set<string>;
  calls: number;
  model?: string;
  tokens: { input: number; output: number };
  /** Anything in a payload shaped other than expected, with the call it came from. */
  drift: (DriftWarning & { at: string; traceId?: string })[];
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function reconstruct(traces: StoredTrace[]): SessionTrace {
  const calls: LlmCall[] = [];
  const out: SessionTrace = {
    tools: [], toolCalls: [], events: [], inputIds: new Set(), calls: traces.length, tokens: { input: 0, output: 0 }, drift: [],
  };
  const ordered = [...traces].sort((a, b) => a.eventAt.localeCompare(b.eventAt) || a.id - b.id);
  for (const trace of ordered) {
    const { call, drift } = normalise(trace.payload);
    calls.push(call);
    out.drift.push(...drift.map((warning) => ({ ...warning, at: call.at, traceId: call.traceId })));
  }

  const records = new Map<string, ToolCallRecord>();
  const record = (tc: NormalisedToolCall, fallbackInput: string | undefined): ToolCallRecord => {
    // A call without an id — not seen from Cognigy, but possible — is known by what it did.
    const key = tc.id || `${tc.name}\u0000${tc.argsRaw}\u0000${records.size}`;
    let found = records.get(key);
    if (!found) {
      found = { seq: records.size + 1, callId: tc.id, inputId: fallbackInput, name: tc.name, args: tc.args, argsRaw: tc.argsRaw, checks: [] };
      records.set(key, found);
    }
    return found;
  };

  for (const call of calls) {
    if (call.inputId) out.inputIds.add(call.inputId);
    if (call.systemPrompt) out.instructions = call.systemPrompt;
    if (call.tools.length) out.tools = call.tools;
    out.model = call.model ?? out.model;
    out.tokens.input += call.tokens.input;
    out.tokens.output += call.tokens.output;

    for (const message of call.history) {
      for (const tc of message.toolCalls) {
        // The history keeps the arguments exactly as the model wrote them.
        record(tc, call.inputId).argsRaw = tc.argsRaw;
      }
      if (message.role === 'tool' && message.toolCallId) {
        const found = records.get(message.toolCallId);
        if (found && found.result === undefined) {
          found.result = message.content;
          found.resultAt = call.at;
          const json = parseJson(message.content);
          if (json !== undefined) found.resultJson = json;
        }
      }
    }

    for (const tc of call.toolCalls) {
      const found = record(tc, call.inputId);
      found.inputId = call.inputId ?? found.inputId;
      found.calledAt = call.at;
      found.args = tc.args;
      found.definition = call.tools.find((tool) => tool.name === tc.name);
      if (call.reply.trim()) found.preamble = call.reply.trim();
      found.llm = {
        model: call.model, modelVersion: call.modelVersion, finishReason: call.finishReason,
        tokens: call.tokens, latencyMs: call.latencyMs,
      };
    }
  }

  // The reply an input ended with is its last call that made no tool calls.
  const replies = new Map<string, string>();
  for (const call of calls) {
    if (call.inputId && call.toolCalls.length === 0 && call.reply.trim()) replies.set(call.inputId, call.reply.trim());
  }
  out.toolCalls = [...records.values()];
  for (const found of out.toolCalls) {
    if (found.inputId && replies.has(found.inputId)) found.replyAfter = replies.get(found.inputId);
    if (!found.definition) found.definition = out.tools.find((tool) => tool.name === found.name);
    const inputId = found.inputId ?? null;
    out.events.push({ kind: 'call', name: found.name, callId: found.callId, detail: found.argsRaw, inputId, at: found.calledAt ?? '' });
    if (found.result !== undefined) {
      out.events.push({ kind: 'result', name: found.name, callId: found.callId, detail: found.result, inputId, at: found.resultAt ?? '' });
    }
  }
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
