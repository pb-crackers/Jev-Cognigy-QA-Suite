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
import type { SessionTrace } from '../traces/reconstruct.ts';
import { estimateTokens } from './chunk.ts';

/** Roughly 11k tokens: room for a long prompt without crowding out the conversation. */
export const MAX_INSTRUCTION_CHARS = 40_000;
/** A tool's arguments or result, trimmed — the grader needs the gist, not a payload. */
export const MAX_TOOL_DETAIL_CHARS = 500;

export interface FixedState {
  instructions?: string;
  tools?: { name: string; description: string }[];
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

function toolLine(event: SessionTrace['events'][number]): Turn {
  const detail = trim(event.detail.trim(), MAX_TOOL_DETAIL_CHARS);
  return {
    role: 'system',
    text: event.kind === 'call' ? `[tool call ${event.name} ${detail}]` : `[tool result ${event.name}: ${detail}]`,
    at: event.at,
    inputId: event.inputId ?? undefined,
    tool: event.kind,
  };
}

/**
 * The transcript with tool calls written in where they happened.
 *
 * Anchored on `inputId`, not timestamps: the trace and the transcript come from
 * different parts of the platform, so their clocks need not agree, but both
 * name the input. A call goes just before the agent's reply to that input; one
 * with no reply goes after the input's last line.
 */
export function withToolLines(turns: Turn[], trace: SessionTrace | undefined): Turn[] {
  if (!trace || trace.events.length === 0) return turns;
  const pending = new Map<string, Turn[]>();
  const orphans: Turn[] = [];
  for (const event of trace.events) {
    if (!event.inputId) {
      orphans.push(toolLine(event));
      continue;
    }
    const list = pending.get(event.inputId) ?? [];
    list.push(toolLine(event));
    pending.set(event.inputId, list);
  }

  const out: Turn[] = [];
  for (const turn of turns) {
    if (turn.role === 'agent' && turn.inputId && pending.has(turn.inputId)) {
      out.push(...pending.get(turn.inputId)!);
      pending.delete(turn.inputId);
    }
    out.push(turn);
  }
  for (const [inputId, lines] of pending) {
    let at = -1;
    out.forEach((turn, index) => {
      if (turn.inputId === inputId) at = index;
    });
    if (at === -1) out.push(...lines);
    else out.splice(at + 1, 0, ...lines);
  }
  return [...out, ...orphans];
}
