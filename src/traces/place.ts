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

/** Enough of a sentence to recognise it through whitespace, markdown and masking differences. */
function gist(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
}

function isPreamble(turn: Turn, calls: ToolCallRecord[]): boolean {
  const said = gist(turn.text);
  if (!said) return false;
  return calls.some((call) => {
    const before = call.preamble ? gist(call.preamble) : '';
    return before !== '' && (before.startsWith(said) || said.startsWith(before));
  });
}

export function placeToolCalls(turns: Turn[], records: ToolCallRecord[]): Placed[] {
  const pending = new Map<string, ToolCallRecord[]>();
  const orphans: ToolCallRecord[] = [];
  for (const record of records) {
    if (!record.inputId) {
      orphans.push(record);
      continue;
    }
    const list = pending.get(record.inputId) ?? [];
    list.push(record);
    pending.set(record.inputId, list);
  }

  const out: Placed[] = [];
  for (const turn of turns) {
    const calls = turn.role === 'agent' && turn.inputId ? pending.get(turn.inputId) : undefined;
    if (calls && !isPreamble(turn, calls)) {
      out.push({ kind: 'calls', inputId: turn.inputId, calls });
      pending.delete(turn.inputId!);
    }
    out.push({ kind: 'turn', turn });
  }

  for (const [inputId, calls] of pending) {
    let at = -1;
    out.forEach((item, index) => {
      if (item.kind === 'turn' && item.turn.inputId === inputId) at = index;
    });
    const block: Placed = { kind: 'calls', inputId, calls };
    if (at === -1) out.push(block);
    else out.splice(at + 1, 0, block);
  }
  if (orphans.length) out.push({ kind: 'calls', calls: orphans });
  return out;
}
