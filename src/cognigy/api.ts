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
}

interface ItemsResponse<T> {
  items?: T[];
  total?: number;
}

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

export class CognigyApi {
  readonly #base: string;
  readonly #apiKey: string;

  constructor(base: string, apiKey: string) {
    this.#base = base.replace(/\/$/, '');
    this.#apiKey = apiKey;
  }

  async #get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.#base}${path}`, {
      headers: { 'X-API-Key': this.#apiKey, accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(
        `Cognigy API ${response.status} on ${path}` +
          (response.status === 401 ? ' — the key was rejected by this host' : ''),
      );
    }
    return (await response.json()) as T;
  }

  async projects(): Promise<CognigyProject[]> {
    const body = await this.#get<ItemsResponse<RawProject>>('/v2.0/projects?limit=100');
    return (body.items ?? []).map((item) => ({
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
    const body = await this.#get<ItemsResponse<RawFlow>>(
      `/v2.0/flows?projectId=${encodeURIComponent(projectId)}&limit=100`,
    );
    return (body.items ?? [])
      .filter((item): item is RawFlow & { referenceId: string } => Boolean(item.referenceId))
      .map((item) => ({ id: item._id, referenceId: item.referenceId, name: item.name }));
  }

  async endpoints(projectId: string): Promise<CognigyEndpoint[]> {
    const body = await this.#get<ItemsResponse<RawNamed>>(
      `/v2.0/endpoints?projectId=${encodeURIComponent(projectId)}&limit=100`,
    );
    return (body.items ?? []).map((item) => ({ id: item._id, name: item.name }));
  }

  /** Cheap liveness probe used by `init`. */
  async check(): Promise<{ projects: number }> {
    return { projects: (await this.projects()).length };
  }
}
