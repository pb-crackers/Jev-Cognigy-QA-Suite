/**
 * Turning Cognigy's `channel` value into something a reviewer can read.
 *
 * `channel` is `input.channel` — whatever the endpoint sets — and Cognigy
 * documents thirty-two endpoint types without enumerating the strings they
 * produce. Only three have been seen against real data. So this maps what is
 * known, makes a readable attempt at what is not, and never invents a label that
 * could be wrong: an unrecognised value is humanised from its own characters and
 * keeps the raw string alongside it.
 *
 * Everything here is a pure function over strings, which is why it lives apart
 * from the OData client.
 */

/** How a label is grouped, for styling and for reading at a glance. */
export type ChannelKind = 'voice' | 'text' | 'panel' | 'unknown';

export interface ChannelLabel {
  /** The raw value Cognigy reported. The fact, as opposed to the presentation. */
  raw: string;
  /** What a reviewer reads. */
  label: string;
  kind: ChannelKind;
  /** False when the label was derived rather than mapped, so the UI can say so. */
  known: boolean;
}

/**
 * Verified against real data. These three are the only strings observed, and
 * both voice gateways deliberately collapse to one label — which gateway version
 * carried the call is not what a reviewer is asking.
 */
const VERIFIED: Record<string, { label: string; kind: ChannelKind }> = {
  adminconsole: { label: 'Interaction Panel', kind: 'panel' },
  voicegateway: { label: 'Voice', kind: 'voice' },
  voicegateway2: { label: 'Voice', kind: 'voice' },
  rest: { label: 'REST API', kind: 'text' },
};

/**
 * Inferred from Cognigy's documented endpoint types. None of these strings has
 * been seen in real data, so a wrong guess here mislabels rather than breaks —
 * and should be corrected as real environments turn up.
 */
const INFERRED: Record<string, { label: string; kind: ChannelKind }> = {
  webchat: { label: 'Webchat', kind: 'text' },
  webchat2: { label: 'Webchat', kind: 'text' },
  webchat3: { label: 'Webchat', kind: 'text' },
  whatsapp: { label: 'WhatsApp', kind: 'text' },
  facebook: { label: 'Facebook', kind: 'text' },
  messenger: { label: 'Facebook', kind: 'text' },
  msteams: { label: 'Microsoft Teams', kind: 'text' },
  slack: { label: 'Slack', kind: 'text' },
  genesys: { label: 'Genesys', kind: 'text' },
  twilio: { label: 'Twilio', kind: 'text' },
  socketio: { label: 'Socket.IO', kind: 'text' },
  webhook: { label: 'Webhook', kind: 'text' },
};

/** A session whose records carry no channel at all. */
export const UNKNOWN_CHANNEL = '(none)';

/**
 * Makes a readable label out of a string nobody has mapped.
 *
 * `someNewChannel` becomes "Some New Channel"; `voice_gateway_3` becomes
 * "Voice Gateway 3". Digits are split from letters so a version suffix does not
 * fuse onto the preceding word.
 */
export function humanise(raw: string): string {
  const spaced = raw
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .trim();

  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function labelFor(raw: string | null | undefined): ChannelLabel {
  const value = (raw ?? '').trim();
  if (!value) {
    return { raw: UNKNOWN_CHANNEL, label: 'Unknown', kind: 'unknown', known: false };
  }

  const mapped = VERIFIED[value.toLowerCase()] ?? INFERRED[value.toLowerCase()];
  if (mapped) return { raw: value, label: mapped.label, kind: mapped.kind, known: true };

  return { raw: value, label: humanise(value), kind: 'unknown', known: false };
}

/**
 * An OData clause restricting `channel` to the given raw values.
 *
 * Chained `or`, never `in`: Cognigy's OData rejects `in (...)` with a 400, as it
 * does `$apply`. Returns undefined for an empty list, meaning no restriction —
 * the caller decides whether "nothing selected" means everything or nothing.
 */
export function channelClause(raws: readonly string[]): string | undefined {
  const values = [...new Set(raws.map((raw) => raw.trim()).filter(Boolean))];
  if (values.length === 0) return undefined;

  const clauses = values.map((value) =>
    value === UNKNOWN_CHANNEL ? 'channel eq null' : `channel eq '${value.replace(/'/g, "''")}'`,
  );
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' or ')})`;
}
