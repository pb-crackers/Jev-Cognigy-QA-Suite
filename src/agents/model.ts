/**
 * What an agent is.
 *
 * Not a Cognigy object. An agent is a group the user defines: which traffic
 * belongs to it (a project and some of its endpoints), which rubrics it is
 * graded against, how often it is collected, and where its alerts go. That is
 * deliberately looser than Cognigy's own AI Agent resource, because most bots in
 * the wild are Flows with LLM Prompt nodes and no AI Agent resource at all.
 */
import type { Rubric } from '../rubrics/model.ts';

/** An endpoint owned by an agent, stored by id so a rename is noticed, not missed. */
export interface AgentEndpoint {
  id: string;
  /** The name at the time it was last resolved. OData filters on this. */
  name: string;
  /** The Flow the endpoint enters, as a Flow `referenceId`. */
  flowRef?: string;
  channel?: string;
}

/** One node Agent Watch wrote logging into, with what was there before. */
export interface LoggingInstall {
  flowId: string;
  flowName: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  installedAt: string;
  /** The three fields exactly as they were, so uninstall puts them back. */
  previous: {
    advancedLogging: unknown;
    loggingWebhookUrl: unknown;
    loggingHeaders: unknown;
  };
}

export interface Agent {
  /** A slug, and also the path segment of the agent's webhook. */
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  endpoints: AgentEndpoint[];
  /**
   * Whether Interaction Panel sessions count as this agent's traffic. Off by
   * default: in a trial environment the panel is most of the data, and a health
   * score that mostly describes developers testing is not a health score.
   */
  includePanel: boolean;
  /**
   * Names of the Flows the agent's endpoints enter, re-read on every collection.
   * They decide which Interaction Panel sessions are this agent's.
   */
  flowNames?: string[];
  /** Explicit per-rubric switches. A rubric absent here follows `defaultOn`. */
  rubrics: Record<string, boolean>;
  /** Watched by the collector. */
  enabled: boolean;
  intervalMinutes: number;
  alerts: { macos: boolean; webhookUrl?: string };
  /** The shared secret Cognigy sends with every trace, and where logging lives. */
  trace: { token: string; installs: LoggingInstall[] };
  createdAt: string;
}

export const DEFAULT_INTERVAL_MINUTES = 60;

/** A URL-safe id from a name: "Summit Ridge Mortgage" → "summit-ridge-mortgage". */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

/**
 * Whether a rubric with no explicit switch is on for an agent.
 *
 * Shipped library rubrics are meant for every agent. A custom rubric was written
 * for one situation — a retail "offered a discount" check has no business
 * running on a mortgage agent just because it now exists.
 */
export function defaultOn(rubric: Pick<Rubric, 'origin'>): boolean {
  return rubric.origin === 'library';
}

export function rubricOn(agent: Pick<Agent, 'rubrics'>, rubric: Pick<Rubric, 'id' | 'origin' | 'enabled'>): boolean {
  if (!rubric.enabled) return false;
  return agent.rubrics[rubric.id] ?? defaultOn(rubric);
}

/** The rubrics an agent is graded against, in library order. */
export function agentRubrics<R extends Rubric>(agent: Pick<Agent, 'rubrics'>, rubrics: R[]): R[] {
  return rubrics.filter((rubric) => rubricOn(agent, rubric));
}

/**
 * The switches a brand-new agent starts with: everything enabled at that moment
 * is on, explicitly. Only rubrics added afterwards fall back to `defaultOn`.
 */
export function initialToggles(rubrics: Pick<Rubric, 'id' | 'enabled'>[]): Record<string, boolean> {
  return Object.fromEntries(rubrics.filter((rubric) => rubric.enabled).map((rubric) => [rubric.id, true]));
}

/** Which agent already owns an endpoint, if any — an endpoint belongs to one agent. */
export function endpointOwner(agents: Agent[], endpointId: string, exceptAgentId?: string): Agent | undefined {
  return agents.find(
    (agent) => agent.id !== exceptAgentId && agent.endpoints.some((endpoint) => endpoint.id === endpointId),
  );
}
