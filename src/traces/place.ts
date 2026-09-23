/**
 * Where each tool call goes in the transcript.
 *
 * One placement serves both readers: the grader, which sees tool calls as lines
 * in the conversation, and the reviewer, who sees them as rows in the session
 * view. Deciding it once is what keeps the two from disagreeing about when the
 * agent called what.
 *
 * Anchored on `inputId`, not timestamps: the trace and the transcript come
 * from different parts of the platform, and their clocks need not agree, but
 * both name the input. An input's calls go just before the agent's reply to it
 * — after any text the agent said before calling, which reached the customer
 * as its own line. Calls with no reply go after the input's last line.
 */
import type { Turn } from '../cognigy/transcript.ts';
import type { ToolCallRecord } from './reconstruct.ts';

export type Placed =
  | { kind: 'turn'; turn: Turn }
  | { kind: 'calls'; inputId?: string; calls: ToolCallRecord[] };

/** Enough of a sentence to recognise it through whitespace, markdown and masking differences, in any script. */
function gist(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 40);
}

function isPreamble(turn: Turn, round: ToolCallRecord[]): boolean {
  const said = gist(turn.text);
  if (!said) return false;
  return round.some((call) => {
    const before = call.preamble ? gist(call.preamble) : '';
    return before !== '' && (before.startsWith(said) || said.startsWith(before));
  });
}

export function placeToolCalls(turns: Turn[], records: ToolCallRecord[]): Placed[] {
  // Each input's calls, split by the LLM response that made them: one response
  // may say something first, and that text is where its calls belong.
  const pending = new Map<string, ToolCallRecord[][]>();
  const orphans: ToolCallRecord[] = [];
  for (const record of records) {
    if (!record.inputId) {
      orphans.push(record);
      continue;
    }
    const rounds = pending.get(record.inputId) ?? [];
    const last = rounds.at(-1);
    if (last && last[0].round === record.round) last.push(record);
    else rounds.push([record]);
    pending.set(record.inputId, rounds);
  }

  const out: Placed[] = [];
  // Calls with nothing said between them share one block on the rail.
  const emit = (inputId: string | undefined, calls: ToolCallRecord[]) => {
    const last = out.at(-1);
    if (last?.kind === 'calls' && last.inputId === inputId) last.calls.push(...calls);
    else out.push({ kind: 'calls', inputId, calls: [...calls] });
  };

  for (const turn of turns) {
    const rounds = turn.role === 'agent' && turn.inputId ? pending.get(turn.inputId) : undefined;
    if (rounds?.length) {
      const said = rounds.findIndex((round) => isPreamble(turn, round));
      if (said >= 0) {
        // Rounds before it happened before the agent said this; its own round follows it.
        for (const round of rounds.splice(0, said)) emit(turn.inputId, round);
        out.push({ kind: 'turn', turn });
        emit(turn.inputId, rounds.shift()!);
        if (!rounds.length) pending.delete(turn.inputId!);
        continue;
      }
      // Not a lead-in: this is the reply, and every call left for the input came before it.
      for (const round of rounds) emit(turn.inputId, round);
      pending.delete(turn.inputId!);
    }
    out.push({ kind: 'turn', turn });
  }

  for (const [inputId, rounds] of pending) {
    let at = -1;
    out.forEach((item, index) => {
      if (item.kind === 'turn' && item.turn.inputId === inputId) at = index;
    });
    const block: Placed = { kind: 'calls', inputId, calls: rounds.flat() };
    if (at === -1) out.push(block);
    else out.splice(at + 1, 0, block);
  }
  if (orphans.length) out.push({ kind: 'calls', calls: orphans });
  return out;
}
