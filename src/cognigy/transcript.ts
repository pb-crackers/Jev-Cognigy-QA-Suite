/**
 * Turns raw `Conversations` records into a readable transcript.
 *
 * The non-obvious part is that a single spoken or written message often arrives
 * as several records. A streaming prompt node emits fragments that share a
 * `_messageId`; some carry text and the last carries only `_finishReason`. Left
 * alone, roughly a quarter of records look like blank turns. Grouped by
 * `_messageId` and concatenated, they read as one utterance.
 *
 * Voice Gateway lifecycle events arrive as records with no text at all, and they
 * matter for review — who ended the call is a QA question — so they become
 * system lines rather than being discarded.
 */
import type { ConversationRecord } from './odata.ts';
import { labelFor, type ChannelLabel } from './channels.ts';

export type Role = 'user' | 'agent' | 'system';

export interface Turn {
  role: Role;
  text: string;
  at: string;
  /** The user input this turn belongs to — the key that joins it to a logged LLM call. */
  inputId?: string;
  /** Flow node that produced the turn, when reported. */
  nodeType?: string;
  nodeLabel?: string;
  /**
   * The node's own id, and the reference id of the Flow it lives in.
   *
   * The label is not an address: four different `say` nodes all report "Say",
   * and a label does not say which Flow it came from. These two do, which is
   * what lets a briefing point at the node rather than describe it.
   */
  nodeId?: string;
  flowRef?: string;
  /** Why generation stopped, for turns from a prompt node. */
  finishReason?: string;
}

export interface Transcript {
  sessionId: string;
  turns: Turn[];
  /** Endpoint name, or "Interaction Panel" when the session had no endpoint. */
  endpointLabel: string;
  channel: string | null;
  /** The channel resolved for display: raw value, readable label, and grouping. */
  channelLabel: ChannelLabel;
  flowName: string | null;
  rating: number | null;
  ratingComment: string | null;
  masked: boolean;
  /** Why this transcript cannot be scored, when it cannot. */
  unscoreable?: 'masked' | 'no-content';
}

export const INTERACTION_PANEL = 'Interaction Panel';

interface Parsed {
  record: ConversationRecord;
  messageId?: string;
  finishReason?: string;
  nodeType?: string;
  nodeLabel?: string;
  nodeId?: string;
  flowRef?: string;
  event?: string;
  payload?: Record<string, unknown>;
}

function parse(record: ConversationRecord): Parsed {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(record.inputData ?? '{}') as Record<string, unknown>;
  } catch {
    // Malformed payloads are not worth failing a transcript over; the record's
    // own text still stands on its own.
  }
  const cognigy = (data._cognigy ?? {}) as Record<string, unknown>;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;

  return {
    record,
    messageId: typeof cognigy._messageId === 'string' ? cognigy._messageId : undefined,
    finishReason: typeof cognigy._finishReason === 'string' ? cognigy._finishReason : undefined,
    nodeType: typeof metadata.nodeType === 'string' ? metadata.nodeType : undefined,
    nodeLabel: typeof metadata.nodeLabel === 'string' ? metadata.nodeLabel : undefined,
    nodeId: typeof metadata.nodeId === 'string' ? metadata.nodeId : undefined,
    flowRef:
      typeof metadata.flowReferenceId === 'string' ? metadata.flowReferenceId : undefined,
    event: typeof data.event === 'string' ? data.event : undefined,
    payload: (data.payload ?? undefined) as Record<string, unknown> | undefined,
  };
}

function roleOf(record: ConversationRecord): Role {
  if (record.type === 'input' || record.source === 'user') return 'user';
  return 'agent';
}

/** A readable system line for a Voice Gateway lifecycle event. */
function eventLine(parsed: Parsed): string | undefined {
  const payload = parsed.payload ?? {};
  // Speech recognition is not a lifecycle event; it is a turn, handled above.
  if (parsed.event === 'RECOGNIZED_SPEECH') return undefined;
  if (parsed.event === 'CALL_CREATED') {
    const direction = payload.direction ?? 'call';
    return `[${direction} call started]`;
  }
  if (parsed.event === 'CALL_COMPLETED') {
    const by = payload.call_termination_by;
    const seconds = typeof payload.duration === 'number' ? payload.duration : undefined;
    const reason = payload.sip_reason;
    const parts = [
      by ? `ended by ${by}` : 'ended',
      seconds !== undefined ? `${seconds}s` : undefined,
      typeof reason === 'string' && reason !== 'OK' ? reason : undefined,
    ].filter(Boolean);
    return `[call ${parts.join(' · ')}]`;
  }
  return parsed.event ? `[${parsed.event}]` : undefined;
}

/** A system line for a node that produced no text but changed the call's state. */
function nodeLine(parsed: Parsed): string | undefined {
  if (parsed.nodeType === 'hangup') return '[agent ended the call]';
  return undefined;
}

export function assemble(
  sessionId: string,
  records: ConversationRecord[],
): Transcript {
  const parsed = records.map(parse);
  const first = records[0];

  const turns: Turn[] = [];
  const groups = new Map<string, Parsed[]>();

  for (const item of parsed) {
    const text = (item.record.inputText ?? '').trim();

    // A record can carry BOTH an event and real speech: on a voice call a
    // RECOGNIZED_SPEECH event *is* the customer's utterance, with the words in
    // `inputText`. Only a record with no text of its own describes what happened
    // to the call rather than what was said in it. Checking the event first
    // silently discarded every caller turn on every voice session.
    if (item.event && !text) {
      const line = eventLine(item);
      if (line) turns.push({ role: 'system', text: line, at: item.record.timestamp });
      continue;
    }

    // Streamed fragments share a message id and are reassembled below. A record
    // with neither an id nor text is a state change, not an utterance.
    if (item.messageId) {
      const group = groups.get(item.messageId);
      if (group) group.push(item);
      else groups.set(item.messageId, [item]);
      continue;
    }

    if (text) {
      turns.push({
        role: roleOf(item.record),
        text,
        at: item.record.timestamp,
        inputId: item.record.inputId || undefined,
        nodeType: item.nodeType,
        nodeLabel: item.nodeLabel,
        nodeId: item.nodeId,
        flowRef: item.flowRef,
      });
      continue;
    }

    const line = nodeLine(item);
    if (line) turns.push({ role: 'system', text: line, at: item.record.timestamp });
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.record.timestamp.localeCompare(b.record.timestamp));
    const text = group
      .map((item) => (item.record.inputText ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();

    const terminator = group.find((item) => item.finishReason);
    const described = group.find((item) => item.nodeType);

    if (text) {
      turns.push({
        role: roleOf(group[0].record),
        text,
        at: group[0].record.timestamp,
        inputId: group[0].record.inputId || undefined,
        nodeType: described?.nodeType,
        nodeLabel: described?.nodeLabel,
        nodeId: described?.nodeId,
        flowRef: described?.flowRef,
        finishReason: terminator?.finishReason,
      });
      continue;
    }

    // A group with no text at all: only worth a line if the node did something.
    const line = nodeLine(group[0]);
    if (line) turns.push({ role: 'system', text: line, at: group[0].record.timestamp });
  }

  turns.sort((a, b) => a.at.localeCompare(b.at));

  const rated = records.find((record) => record.rating !== null);
  const masked = records.some((record) => Boolean(record.isMasked));
  const spoken = turns.filter((turn) => turn.role !== 'system');

  return {
    sessionId,
    turns,
    endpointLabel: first?.endpointName ?? INTERACTION_PANEL,
    channel: first?.channel ?? null,
    channelLabel: labelFor(first?.channel),
    flowName: records.find((record) => record.flowName)?.flowName ?? null,
    rating: rated?.rating ?? null,
    ratingComment: rated?.ratingComment ?? null,
    masked,
    unscoreable: masked ? 'masked' : spoken.length === 0 ? 'no-content' : undefined,
  };
}

/** Plain-text rendering, which is what the model is given as state. */
export function render(transcript: Transcript): string {
  return transcript.turns
    .map((turn) => {
      if (turn.role === 'system') return turn.text;
      const who = turn.role === 'user' ? 'Customer' : 'Agent';
      return `${who}: ${turn.text}`;
    })
    .join('\n');
}
