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
    limit: number;
  }): Promise<SessionSummary[]> {
    const clauses = [
      `projectId eq ${odataString(options.projectId)}`,
      `timestamp ge ${options.from}`,
      `timestamp le ${options.to}`,
    ];
    if (options.endpointName === null) clauses.push('endpointName eq null');
    else if (options.endpointName !== undefined) {
      clauses.push(`endpointName eq ${odataString(options.endpointName)}`);
    }

    const channels = options.channels ? channelClause(options.channels) : undefined;
    if (channels) clauses.push(channels);

    const byId = new Map<string, SessionSummary>();

    // OData here has no $apply/groupby, so sessions are derived by walking
    // records newest-first and folding them together.
    for (let skip = 0; skip < 20_000; skip += 1000) {
      const page = await this.#get<{ value: ConversationRecord[] }>(
        `/Conversations?$filter=${encodeURIComponent(clauses.join(' and '))}` +
          `&$orderby=timestamp desc&$top=1000&$skip=${skip}` +
          `&$select=sessionId,timestamp,endpointName,channel,rating,isMasked,type`,
      );

      for (const record of page.value) {
        const existing = byId.get(record.sessionId);
        if (existing) {
          existing.records++;
          if (record.timestamp < existing.startedAt) existing.startedAt = record.timestamp;
          if (record.rating !== null) existing.rating = record.rating;
          if (record.isMasked) existing.masked = true;
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
        if (byId.size >= options.limit && page.value.length < 1000) break;
      }

      if (page.value.length < 1000) break;
      if (byId.size >= options.limit) break;
    }

    return [...byId.values()]
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
      .slice(0, options.limit);
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
