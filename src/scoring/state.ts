/**
 * What the grader reads.
 *
 * Without traces the state is exactly what it has always been — the
 * conversation and the Flow — and a test pins that. With a fully or partly
 * logged session it gains two things the transcript alone cannot provide: the
 * agent's instructions as they were sent, and its tools. Tool calls and their
 * results are written into the conversation itself, where they happened, so a
 * rubric can see "the agent quoted a payment" and "no tool was called" side by
 * side.
 */
import type { Turn } from '../cognigy/transcript.ts';
import type { SessionTrace, ToolCallRecord } from '../traces/reconstruct.ts';
import { placeToolCalls } from '../traces/place.ts';
import type { ToolDefinition } from '../traces/normalise.ts';
import { estimateTokens } from './chunk.ts';

/** Roughly 11k tokens: room for a long prompt without crowding out the conversation. */
export const MAX_INSTRUCTION_CHARS = 40_000;
/**
 * A tool's arguments or result, trimmed with a visible marker. Long enough for a
 * knowledge-search result's substance (they run to 4.5k characters), short
 * enough that a busy session still fits Jev's 32k-token state.
 */
export const MAX_TOOL_DETAIL_CHARS = 2_000;

export interface FixedState {
  instructions?: string;
  /** With each tool's parameter schema, so arguments can be judged against it. */
  tools?: ToolDefinition[];
}

function trim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} …[trimmed ${text.length - max} characters]`;
}

/** The parts of the state that are the same for every chunk of a session. */
export function fixedState(trace: SessionTrace | undefined): FixedState {
  if (!trace) return {};
  return {
    ...(trace.instructions ? { instructions: trim(trace.instructions, MAX_INSTRUCTION_CHARS) } : {}),
    ...(trace.tools.length ? { tools: trace.tools } : {}),
  };
}

export function fixedTokens(fixed: FixedState): number {
  return fixed.instructions || fixed.tools ? estimateTokens(JSON.stringify(fixed)) : 0;
}

function toolLines(call: ToolCallRecord): Turn[] {
  const base = { role: 'system' as const, inputId: call.inputId };
  const lines: Turn[] = [{ ...base, text: `[tool call ${call.name} ${trim(call.argsRaw.trim(), MAX_TOOL_DETAIL_CHARS)}]`, at: call.calledAt ?? '', tool: 'call' }];
  if (call.result !== undefined) {
    lines.push({ ...base, text: `[tool result ${call.name}: ${trim(call.result.trim(), MAX_TOOL_DETAIL_CHARS)}]`, at: call.resultAt ?? '', tool: 'result' });
  }
  return lines;
}

/**
 * The transcript with tool calls written in where they happened, as the grader
 * reads it. Placement is shared with the session view — see `placeToolCalls`.
 */
export function withToolLines(turns: Turn[], trace: SessionTrace | undefined): Turn[] {
  if (!trace || trace.toolCalls.length === 0) return turns;
  return placeToolCalls(turns, trace.toolCalls).flatMap((item) =>
    item.kind === 'turn' ? [item.turn] : item.calls.flatMap(toolLines));
}
