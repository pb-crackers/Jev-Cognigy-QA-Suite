/**
 * Cognigy OData analytics feed — the source of transcripts.
 *
 * Authenticates with the `apikey` header (the management API uses `X-API-Key`).
 * Cognigy allows 10 requests/second, 4 concurrent and a 50-request burst, and
 * filtering by `projectId` earns a per-project budget instead of sharing the
 * organisation's, so every query here is project-scoped.
 */
export interface ConversationRecord {
  id: string;
  sessionId: string;
  inputId: string;
  projectId: string;
  projectName: string | null;
  inputText: string | null;
  inputData: string | null;
  type: string;
  source: string;
  timestamp: string;
  flowName: string | null;
  channel: string | null;
  endpointName: string | null;
  inHandoverRequest: boolean | null;
  inHandoverConversation: boolean | null;
  rating: number | null;
  ratingComment: string | null;
  isMasked: boolean | null;
}

import { channelClause } from './channels.ts';

/** Cap on in-flight requests, matching Cognigy's concurrency limit. */
const MAX_CONCURRENT = 4;
const MAX_RETRIES = 4;

function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * An OData clause for an agent's traffic: any of its endpoints, and the
 * Interaction Panel only when asked for. Chained `or`, never `in`, which this
 * OData rejects. `null` means the agent has no traffic at all, and the caller
 * should not query.
 */
export function endpointClause(
  names: readonly string[],
  includePanel: boolean,
  panelFlows: readonly string[] = [],
): string | null {
  const clauses = [...new Set(names.map((name) => name.trim()).filter(Boolean))].map(
    (name) => `endpointName eq ${odataString(name)}`,
  );
  if (includePanel) {
    // Panel sessions have no endpoint to tell them apart, so without a Flow
    // restriction "include the panel" would take every developer test in the
    // project, whichever bot it was testing.
    const flows = [...new Set(panelFlows.map((flow) => flow.trim()).filter(Boolean))].map(
      (flow) => `flowName eq ${odataString(flow)}`,
    );
    clauses.push(
      flows.length === 0 ? 'endpointName eq null'
        : `(endpointName eq null and ${flows.length === 1 ? flows[0] : `(${flows.join(' or ')})`})`,
    );
  }
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' or ')})`;
}

export class OdataClient {
  readonly #base: string;
  readonly #apiKey: string;
  #inFlight = 0;
  readonly #queue: (() => void)[] = [];

  constructor(base: string, apiKey: string) {
    this.#base = base;
    this.#apiKey = apiKey;
  }

  /** Admits at most MAX_CONCURRENT callers at a time. */
  async #acquire(): Promise<void> {
    if (this.#inFlight < MAX_CONCURRENT) {
      this.#inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#inFlight++;
  }

  #release(): void {
    this.#inFlight--;
    this.#queue.shift()?.();
  }

  /**
   * One GET with rate-limit handling. A 429 carries `Retry-After` in seconds
   * and is retried rather than surfaced, because a paced batch is expected to
   * hit the limit and should simply take longer.
   */
  async #get<T>(path: string): Promise<T> {
    await this.#acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(`${this.#base.replace(/\/$/, '')}${path}`, {
          headers: { apikey: this.#apiKey, accept: 'application/json' },
        });

        if (response.status === 429 && attempt < MAX_RETRIES) {
          const after = Number(response.headers.get('retry-after') ?? 5);
          await new Promise((resolve) => setTimeout(resolve, Math.min(after, 30) * 1000));
          continue;
        }

        if (!response.ok) {
          throw new Error(
            `OData ${response.status} on ${path}` +
              (response.status === 401
                ? ' — the key was rejected by this host. The OData host is' +
                  ' region-matched to the API host, so api-…-us pairs with odata-…-us.'
                : ''),
          );
        }
        return (await response.json()) as T;
      }
    } finally {
      this.#release();
    }
  }

  /** Every `Conversations` record for one session, in order. */
  async conversation(projectId: string, sessionId: string): Promise<ConversationRecord[]> {
    const filter = `projectId eq ${odataString(projectId)} and sessionId eq ${odataString(sessionId)}`;
    const records: ConversationRecord[] = [];

    for (let skip = 0; ; skip += 500) {
      const page = await this.#get<{ value: ConversationRecord[] }>(
        `/Conversations?$filter=${encodeURIComponent(filter)}` +
          `&$orderby=timestamp asc&$top=500&$skip=${skip}`.replace(/ /g, '%20'),
      );
      records.push(...page.value);
      if (page.value.length < 500) return records;
    }
  }

  /**
   * Distinct sessions for a project in a date range, optionally narrowed to one
   * endpoint. A session with no `endpointName` came from the Interaction Panel;
   * those are in scope, so `endpointName: null` is a selectable filter rather
   * than an exclusion.
   */
  async sessions(options: {
    projectId: string;
    from: string;
    to: string;
    /** Endpoint name, `null` for Interaction Panel only, or undefined for any. */
    endpointName?: string | null;
    /**
     * Raw `channel` values to include. Omitted means every channel. Applied here,
     * in session discovery, so an excluded session is never fetched, never
     * assembled and never scored.
     */
    channels?: readonly string[];
    /**
     * An agent's endpoints, by name. Takes precedence over `endpointName`. With
     * `includePanel` the Interaction Panel is added; with neither there is no
     * traffic and nothing is queried.
     */
    endpointNames?: readonly string[];
    includePanel?: boolean;
    /** The agent's Flows, which restrict which Interaction Panel sessions are its own. */
    panelFlowNames?: readonly string[];
    /**
     * Walk oldest-first. Catch-up after a gap has to process sessions in the
     * order they happened, or the watermark would jump past unprocessed ones.
     */
    oldestFirst?: boolean;
    /**
     * Particular sessions, whenever they happened — a failed session being
     * retried. Replaces the time range; the traffic filters still apply.
     * Keep it to a couple of dozen: each id is one clause, and OData allows 100.
     */
    sessionIds?: readonly string[];
    limit: number;
  }): Promise<SessionSummary[] & { truncated?: boolean }> {
    const clauses = [`projectId eq ${odataString(options.projectId)}`];
    if (options.sessionIds) {
      if (options.sessionIds.length === 0) return [];
      // Chained `or`: this OData rejects `in (...)`.
      clauses.push(`(${options.sessionIds.map((id) => `sessionId eq ${odataString(id)}`).join(' or ')})`);
    } else {
      clauses.push(`timestamp ge ${options.from}`, `timestamp le ${options.to}`);
    }
    if (options.endpointNames) {
      const traffic = endpointClause(options.endpointNames, options.includePanel ?? false, options.panelFlowNames);
      if (!traffic) return [];
      clauses.push(traffic);
    } else if (options.endpointName === null) clauses.push('endpointName eq null');
    else if (options.endpointName !== undefined) {
      clauses.push(`endpointName eq ${odataString(options.endpointName)}`);
    }

    const channels = options.channels ? channelClause(options.channels) : undefined;
    if (channels) clauses.push(channels);

    const byId = new Map<string, SessionSummary>();

    const order = options.oldestFirst ? 'asc' : 'desc';
    const MAX_RECORDS = 20_000;
    let truncated = false;

    // OData here has no $apply/groupby, so sessions are derived by walking
    // records and folding them together.
    for (let skip = 0; skip < MAX_RECORDS; skip += 1000) {
      const page = await this.#get<{ value: ConversationRecord[] }>(
        `/Conversations?$filter=${encodeURIComponent(clauses.join(' and '))}` +
          `&$orderby=timestamp ${order}&$top=1000&$skip=${skip}` +
          `&$select=sessionId,timestamp,endpointName,channel,rating,isMasked,type`,
      );

      for (const record of page.value) {
        const existing = byId.get(record.sessionId);
        if (existing) {
          existing.records++;
          if (record.timestamp < existing.startedAt) existing.startedAt = record.timestamp;
          if (record.timestamp > existing.lastAt) existing.lastAt = record.timestamp;
          if (record.rating !== null) existing.rating = record.rating;
          if (record.isMasked) existing.masked = true;
        } else if (options.oldestFirst && byId.size >= options.limit) {
          // Full: later records may still extend sessions already held, but no
          // new session is started beyond the limit.
          continue;
        } else {
          byId.set(record.sessionId, {
            sessionId: record.sessionId,
            startedAt: record.timestamp,
            lastAt: record.timestamp,
            endpointName: record.endpointName,
            channel: record.channel,
            rating: record.rating,
            masked: Boolean(record.isMasked),
            records: 1,
          });
        }
        if (!options.oldestFirst && byId.size >= options.limit && page.value.length < 1000) break;
      }

      if (page.value.length < 1000) break;
      if (byId.size >= options.limit) break;
      // A full last page at the cap means records were left unread.
      if (skip + 1000 >= MAX_RECORDS) truncated = true;
    }

    const all = [...byId.values()];
    const result = options.oldestFirst
      ? all.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(0, options.limit)
      : all.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, options.limit);
    return Object.assign(result, { truncated });
  }

  /** Cheap liveness probe used by `init`. */
  async check(): Promise<{ records: number }> {
    const page = await this.#get<{ value: unknown[] }>('/Conversations?$top=1');
    return { records: page.value.length };
  }
}

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  lastAt: string;
  endpointName: string | null;
  channel: string | null;
  rating: number | null;
  masked: boolean;
  /** Raw record count, before turns are assembled. */
  records: number;
}
