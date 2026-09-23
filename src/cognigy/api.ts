/**
 * Cognigy management API — projects and endpoints.
 *
 * Two things about this surface are easy to get wrong. It authenticates with
 * `X-API-Key`, while the OData feed uses `apikey` — same key, different header.
 * And it content-negotiates: sending `accept: application/json` returns a flat
 * `{ items: [{ _id, name }] }` shape, whereas omitting it returns HAL with the
 * id buried in a self link. The flat shape is what we want, so the header is
 * always sent.
 */
export interface CognigyProject {
  id: string;
  name: string;
  /** The project's primary locale, which the Flow editor URL is scoped to. */
  localeId?: string;
}

export interface CognigyFlow {
  id: string;
  /** What a transcript record calls `flowReferenceId`; the join key. */
  referenceId: string;
  name: string;
}

export interface CognigyEndpoint {
  id: string;
  name: string;
  /** The Flow the endpoint enters, as a Flow `referenceId`. */
  flowRef?: string;
  channel?: string;
  /** The endpoint's public token — the last segment of its URL. */
  urlToken?: string;
}

/** A Cognigy AI Agent resource — the persona and instructions, not the Flow. */
export interface CognigyAiAgent {
  id: string;
  referenceId: string;
  name: string;
}

/** A Flow node as listed: enough to find the LLM nodes, not its configuration. */
export interface FlowNodeSummary {
  id: string;
  type: string;
  label: string;
}

/** A single node with its full configuration. */
export interface FlowNode extends FlowNodeSummary {
  config: Record<string, unknown>;
}

interface ItemsResponse<T> {
  items?: T[];
  total?: number;
  nextCursor?: string | null;
}

/**
 * The Management API caps a page at 25 items whatever `limit` asks for, and says
 * so only by returning a `nextCursor`. Asking for 300 nodes and getting 25 is
 * silent truncation, so every list here walks the cursor.
 */
const PAGE = 25;
/** A guard against a cursor that never ends. */
const MAX_PAGES = 200;

interface RawNamed {
  _id: string;
  name: string;
}

interface RawProject extends RawNamed {
  primaryLocaleReference?: string;
}

interface RawFlow extends RawNamed {
  referenceId?: string;
}

interface RawEndpoint extends RawNamed {
  flowId?: string;
  channel?: string;
  URLToken?: string;
}

interface RawAiAgent extends RawNamed {
  referenceId: string;
}

interface RawNode {
  _id: string;
  type: string;
  label?: string;
  config?: Record<string, unknown>;
}

export class CognigyApi {
  readonly #base: string;
  readonly #apiKey: string;

  constructor(base: string, apiKey: string) {
    this.#base = base.replace(/\/$/, '');
    this.#apiKey = apiKey;
  }

  async #request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.#base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'X-API-Key': this.#apiKey,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Cognigy API ${response.status} on ${init.method ?? 'GET'} ${path}` +
          (response.status === 401 ? ' — the key was rejected by this host' : '') +
          (detail && response.status !== 401 ? ` — ${detail.slice(0, 200)}` : ''),
      );
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  #get<T>(path: string): Promise<T> {
    return this.#request<T>(path);
  }

  /** Every item of a list endpoint, following the cursor past the 25-item page. */
  async #all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    const joiner = path.includes('?') ? '&' : '?';
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.#get<ItemsResponse<T>>(
        `${path}${joiner}limit=${PAGE}${cursor ? `&next=${encodeURIComponent(cursor)}` : ''}`,
      );
      items.push(...(body.items ?? []));
      cursor = body.nextCursor;
      if (!cursor) return items;
    }
    throw new Error(`Cognigy API: gave up following ${path} after ${MAX_PAGES} pages`);
  }

  async projects(): Promise<CognigyProject[]> {
    const items = await this.#all<RawProject>('/v2.0/projects');
    return items.map((item) => ({
      id: item._id,
      name: item.name,
      localeId: item.primaryLocaleReference,
    }));
  }

  /**
   * The project's Flows, keyed for joining to a transcript.
   *
   * A record reports the Flow it ran in as `flowReferenceId`, a UUID, whereas
   * the editor URL wants the Flow's `_id`. This is the only place the two are
   * brought together.
   */
  async flows(projectId: string): Promise<CognigyFlow[]> {
    const items = await this.#all<RawFlow>(`/v2.0/flows?projectId=${encodeURIComponent(projectId)}`);
    return items
      .filter((item): item is RawFlow & { referenceId: string } => Boolean(item.referenceId))
      .map((item) => ({ id: item._id, referenceId: item.referenceId, name: item.name }));
  }

  async endpoints(projectId: string): Promise<CognigyEndpoint[]> {
    const items = await this.#all<RawEndpoint>(
      `/v2.0/endpoints?projectId=${encodeURIComponent(projectId)}`,
    );
    return items.map((item) => ({
      id: item._id,
      name: item.name,
      flowRef: item.flowId || undefined,
      channel: item.channel,
      urlToken: item.URLToken || undefined,
    }));
  }

  async aiAgents(projectId: string): Promise<CognigyAiAgent[]> {
    const items = await this.#all<RawAiAgent>(`/v2.0/aiagents?projectId=${encodeURIComponent(projectId)}`);
    return items.map((item) => ({ id: item._id, referenceId: item.referenceId, name: item.name }));
  }

  /** Every node in a Flow, without configuration — the list omits it. */
  async flowNodes(flowId: string): Promise<FlowNodeSummary[]> {
    const items = await this.#all<RawNode>(`/v2.0/flows/${encodeURIComponent(flowId)}/chart/nodes`);
    return items.map((item) => ({ id: item._id, type: item.type, label: item.label ?? '' }));
  }

  async node(flowId: string, nodeId: string): Promise<FlowNode> {
    const item = await this.#get<RawNode>(
      `/v2.0/flows/${encodeURIComponent(flowId)}/chart/nodes/${encodeURIComponent(nodeId)}`,
    );
    return { id: item._id, type: item.type, label: item.label ?? '', config: item.config ?? {} };
  }

  /**
   * Writes a node's configuration.
   *
   * The API does not say whether `config` is merged or replaced, so this always
   * sends a complete configuration — the caller reads the node, changes only
   * what it means to, and writes the whole thing back. Under either behaviour
   * that leaves every other field exactly as it was.
   */
  async updateNodeConfig(flowId: string, nodeId: string, config: Record<string, unknown>): Promise<void> {
    await this.#request(
      `/v2.0/flows/${encodeURIComponent(flowId)}/chart/nodes/${encodeURIComponent(nodeId)}`,
      { method: 'PATCH', body: { config } },
    );
  }

  /** Cheap liveness probe used by `init`. */
  async check(): Promise<{ projects: number }> {
    return { projects: (await this.projects()).length };
  }
}
