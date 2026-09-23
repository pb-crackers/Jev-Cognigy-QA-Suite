/**
 * Creating, changing and running agents.
 *
 * The rules that make an agent coherent live here rather than in the HTTP
 * handler or the CLI, so both enforce them the same way: an endpoint belongs to
 * one agent, an agent has some traffic, and a renamed endpoint is noticed.
 */
import { randomUUID } from 'node:crypto';
import type { CognigyApi } from '../cognigy/api.ts';
import type { Rubric } from '../rubrics/model.ts';
import type { RunRequest } from '../scoring/run.ts';
import type { Store } from '../store/db.ts';
import {
  type Agent, type AgentEndpoint, DEFAULT_INTERVAL_MINUTES, agentRubrics, endpointOwner, initialToggles, slugify,
} from './model.ts';

export interface AgentInput {
  id?: string;
  name: string;
  projectId: string;
  projectName?: string;
  endpoints: AgentEndpoint[];
  includePanel?: boolean;
  rubrics?: Record<string, boolean>;
  enabled?: boolean;
  intervalMinutes?: number;
  alerts?: Agent['alerts'];
}

/** Every problem with a proposed agent, at once, so a caller can fix them together. */
export function agentProblems(input: Partial<AgentInput>, agents: Agent[], editingId?: string): string[] {
  const problems: string[] = [];
  if (!input.name?.trim()) problems.push('name is required');
  if (!input.projectId?.trim()) problems.push('projectId is required');
  const endpoints = input.endpoints ?? [];
  if (endpoints.length === 0 && !input.includePanel) {
    problems.push('an agent needs at least one endpoint, or the Interaction Panel switched on');
  }
  for (const endpoint of endpoints) {
    if (!endpoint.id || !endpoint.name) problems.push('each endpoint needs an id and a name');
    const owner = endpointOwner(agents, endpoint.id, editingId);
    if (owner) problems.push(`endpoint "${endpoint.name}" already belongs to agent "${owner.name}"`);
  }
  if (input.intervalMinutes !== undefined && !(input.intervalMinutes >= 5 && input.intervalMinutes <= 1440)) {
    problems.push('intervalMinutes must be between 5 and 1440');
  }
  const hook = input.alerts?.webhookUrl;
  if (hook && !/^https?:\/\//.test(hook)) problems.push('alerts.webhookUrl must be an http(s) URL');
  return problems;
}

/** An id not already taken: "summit", then "summit-2". */
function freeId(base: string, agents: Agent[]): string {
  const taken = new Set(agents.map((agent) => agent.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function createAgent(input: AgentInput, store: Store, rubrics: Rubric[]): Agent {
  const agents = store.agents();
  const problems = agentProblems(input, agents);
  if (problems.length) throw new AgentError(problems);

  const agent: Agent = {
    id: freeId(slugify(input.id?.trim() || input.name), agents),
    name: input.name.trim(),
    projectId: input.projectId,
    projectName: input.projectName ?? input.projectId,
    endpoints: input.endpoints,
    includePanel: input.includePanel ?? false,
    rubrics: input.rubrics ?? initialToggles(rubrics),
    enabled: input.enabled ?? true,
    intervalMinutes: input.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    alerts: input.alerts ?? { macos: true },
    trace: { token: randomUUID(), installs: [] },
    createdAt: new Date().toISOString(),
  };
  store.saveAgent(agent);
  return agent;
}

/** Applies a partial change. Identity, the trace token and logging installs are not editable here. */
export function updateAgent(id: string, change: Partial<AgentInput>, store: Store): Agent {
  const current = store.agent(id);
  if (!current) throw new AgentError([`no agent "${id}"`]);
  const next: Agent = {
    ...current,
    name: change.name?.trim() || current.name,
    endpoints: change.endpoints ?? current.endpoints,
    includePanel: change.includePanel ?? current.includePanel,
    rubrics: change.rubrics ? { ...current.rubrics, ...change.rubrics } : current.rubrics,
    enabled: change.enabled ?? current.enabled,
    intervalMinutes: change.intervalMinutes ?? current.intervalMinutes,
    alerts: change.alerts ? { ...current.alerts, ...change.alerts } : current.alerts,
  };
  const problems = agentProblems({ ...next, projectId: next.projectId }, store.agents(), id);
  if (problems.length) throw new AgentError(problems);
  store.saveAgent(next);
  return next;
}

/**
 * Re-reads the agent's endpoints by id and picks up renames.
 *
 * OData filters on the endpoint's *name*, so a rename would otherwise make the
 * agent silently match nothing. Returns what changed so it can be shown.
 */
export async function resolveEndpoints(
  agent: Agent,
  api: Pick<CognigyApi, 'endpoints'>,
  store: Store,
): Promise<{ agent: Agent; warnings: string[] }> {
  const live = new Map((await api.endpoints(agent.projectId)).map((endpoint) => [endpoint.id, endpoint]));
  const warnings: string[] = [];
  const endpoints = agent.endpoints.map((endpoint) => {
    const now = live.get(endpoint.id);
    if (!now) {
      warnings.push(`endpoint "${endpoint.name}" no longer exists in Cognigy`);
      return endpoint;
    }
    if (now.name !== endpoint.name) {
      warnings.push(`endpoint "${endpoint.name}" was renamed to "${now.name}"; following the new name`);
      return { ...endpoint, name: now.name, flowRef: now.flowRef ?? endpoint.flowRef };
    }
    return endpoint;
  });
  if (warnings.length === 0) return { agent, warnings };
  const next = { ...agent, endpoints };
  store.saveAgent(next);
  return { agent: next, warnings };
}

/** The run request that scores one agent's traffic over a range. */
export function agentRunRequest(
  agent: Agent,
  rubrics: Rubric[],
  range: { from: string; to: string; limit?: number; settledBefore?: string; oldestFirst?: boolean },
): RunRequest {
  return {
    projectId: agent.projectId,
    projectName: agent.projectName,
    from: range.from,
    to: range.to,
    limit: range.limit ?? 300,
    skipScored: true,
    skipMode: 'rubric',
    agentId: agent.id,
    label: agent.name,
    endpointNames: agent.endpoints.map((endpoint) => endpoint.name),
    includePanel: agent.includePanel,
    rubricIds: agentRubrics(agent, rubrics).map((rubric) => rubric.id),
    settledBefore: range.settledBefore,
    oldestFirst: range.oldestFirst,
  };
}

export class AgentError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}
