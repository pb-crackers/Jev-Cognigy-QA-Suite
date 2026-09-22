/**
 * Building a link into the Cognigy Flow editor.
 *
 * A node's label is not an address — four different `say` nodes all report
 * "Say", and a label says nothing about which Flow it lives in. A link is,
 * which is the whole reason this file exists.
 *
 * The editor URL is
 * `https://<app host>/project/<project>/<locale>/flow/<flow>/chart/<node>`,
 * verified against a real editor URL. The app host is not the API host: the API
 * is reached at `api-trial-us.cognigy.ai` and the editor at `trial-us.cognigy.ai`.
 * That `api-` prefix is the only rule available, and it is inferred from one
 * environment, so it is overridable and every function here returns `undefined`
 * rather than guessing. A missing link costs a reader one lookup; a wrong link
 * sends them somewhere that does not exist.
 */

/** The parts a node URL needs. Any of them missing means no URL. */
export interface NodeAddress {
  appHost: string | undefined;
  projectId: string | undefined;
  localeId: string | undefined;
  flowId: string | undefined;
  nodeId: string | undefined;
}

/**
 * The Flow editor host for an API base, or `undefined` when it cannot be told.
 *
 * `https://api-trial-us.cognigy.ai` gives `trial-us.cognigy.ai`. A host without
 * the prefix is not assumed to be its own editor host, because a wrong guess
 * here produces links that all 404.
 */
export function appHostFrom(apiBase: string | undefined): string | undefined {
  if (!apiBase?.trim()) return undefined;

  let host: string;
  try {
    host = new URL(apiBase.includes('://') ? apiBase : `https://${apiBase}`).host;
  } catch {
    return undefined;
  }

  return host.startsWith('api-') ? host.slice('api-'.length) : undefined;
}

/** The configured override, normalised to a bare host. */
export function appHostFromOverride(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).host;
  } catch {
    return undefined;
  }
}

/** A Flow editor URL, or `undefined` unless every part is present. */
export function nodeUrl(address: NodeAddress): string | undefined {
  const { appHost, projectId, localeId, flowId, nodeId } = address;
  if (!appHost || !projectId || !localeId || !flowId || !nodeId) return undefined;
  return `https://${appHost}/project/${projectId}/${localeId}/flow/${flowId}/chart/${nodeId}`;
}

/** A turn, as far as link building is concerned. */
export interface LinkableTurn {
  nodeType?: string;
  nodeLabel?: string;
  nodeId?: string;
  flowRef?: string;
}

export interface ResolverInput {
  appHost: string | undefined;
  projectId: string;
  localeId: string | undefined;
  /** Flow reference id to `{ id, name }`, from the Management API. */
  flows: Map<string, { id: string; name: string }>;
  /** Flow reference ids actually seen in the run's transcripts. */
  flowsInRun: Set<string>;
}

/**
 * Builds the resolver the briefing asks for.
 *
 * `describe` names the Flow only when the run spans more than one, because in a
 * single-Flow run saying so on every line is noise the reader already knows.
 */
export function nodeResolver(input: ResolverInput) {
  const multipleFlows = input.flowsInRun.size > 1;

  return {
    url(turn: LinkableTurn): string | undefined {
      return nodeUrl({
        appHost: input.appHost,
        projectId: input.projectId,
        localeId: input.localeId,
        flowId: turn.flowRef ? input.flows.get(turn.flowRef)?.id : undefined,
        nodeId: turn.nodeId,
      });
    },
    describe(turn: LinkableTurn): string | undefined {
      const flowName = turn.flowRef ? input.flows.get(turn.flowRef)?.name : undefined;
      const parts = [
        turn.nodeLabel,
        turn.nodeType,
        multipleFlows ? flowName : undefined,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(' · ') : undefined;
    },
  };
}

/**
 * Assembles a resolver for a run: two Management API calls, never one per
 * session.
 *
 * Resolution happens when the briefing is built rather than when the run is
 * scored, so nothing derived is stored and a renamed Flow reads correctly
 * afterwards. A Flow deleted since the run simply does not come back, and its
 * nodes fall through to the unlinked form.
 *
 * Takes raw transcript JSON rather than store rows so this stays inside the
 * Cognigy layer. Never throws: a briefing is worth more than its links.
 */
export async function resolveNodes(input: {
  api: { projects(): Promise<{ id: string; localeId?: string }[]>;
         flows(projectId: string): Promise<{ id: string; referenceId: string; name: string }[]> };
  apiBase: string | undefined;
  appBase: string | undefined;
  projectId: string;
  transcripts: string[];
}) {
  const flowsInRun = new Set<string>();
  for (const raw of input.transcripts) {
    try {
      for (const turn of JSON.parse(raw) as LinkableTurn[]) {
        if (turn.flowRef) flowsInRun.add(turn.flowRef);
      }
    } catch {
      // A transcript that will not parse contributes no Flows; the briefing
      // already tolerates one and says so where it is quoted.
    }
  }

  const appHost = appHostFromOverride(input.appBase) ?? appHostFrom(input.apiBase);
  const flows = new Map<string, { id: string; name: string }>();
  let localeId: string | undefined;

  if (appHost && flowsInRun.size > 0) {
    try {
      const [projects, list] = await Promise.all([
        input.api.projects(),
        input.api.flows(input.projectId),
      ]);
      localeId = projects.find((project) => project.id === input.projectId)?.localeId;
      for (const flow of list) flows.set(flow.referenceId, { id: flow.id, name: flow.name });
    } catch {
      // An unreachable Management API costs the links, not the briefing.
    }
  }

  return nodeResolver({ appHost, projectId: input.projectId, localeId, flows, flowsInRun });
}
