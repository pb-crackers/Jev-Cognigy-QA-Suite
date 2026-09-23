/**
 * Proposing agents from what already exists in a project.
 *
 * Nobody should have to assemble an agent by hand from endpoint names. An
 * endpoint enters a Flow; if that Flow runs an AI Agent node, the agent is
 * named after the AI Agent resource it uses, and every endpoint leading to the
 * same AI Agent — a REST endpoint and a voice gateway, say — is one agent.
 * Nothing is watched until a suggestion is adopted.
 */
import type { CognigyApi } from '../cognigy/api.ts';
import { type Agent, type AgentEndpoint, endpointOwner, slugify } from './model.ts';
import { findLlmNodes } from './nodes.ts';

export interface Suggestion {
  id: string;
  name: string;
  /** The AI Agent resource the traffic runs, when there is one. */
  aiAgent?: string;
  endpoints: AgentEndpoint[];
  /** LLM nodes reachable from the endpoints' entry Flows — where logging would go. */
  llmNodes: number;
  /** Set when an endpoint here already belongs to an agent. */
  ownedBy?: string;
  /**
   * No usable entry Flow: either none is configured (plumbing, not an agent)
   * or the one configured no longer exists. Listed last.
   */
  noFlow: boolean;
}

type Api = Pick<CognigyApi, 'endpoints' | 'flows' | 'aiAgents' | 'flowNodes' | 'node'>;

export async function suggestAgents(api: Api, projectId: string, existing: Agent[]): Promise<Suggestion[]> {
  const [endpoints, flows, aiAgents] = await Promise.all([
    api.endpoints(projectId),
    api.flows(projectId),
    api.aiAgents(projectId),
  ]);
  const agentByRef = new Map(aiAgents.map((agent) => [agent.referenceId, agent]));
  const knownFlows = new Set(flows.map((flow) => flow.referenceId));

  // One traversal per distinct entry Flow: which AI Agent it runs, and how many
  // LLM nodes are reachable from it, following Go To links.
  const flowInfo = new Map<string, { aiAgent?: string; llmNodes: number }>();
  for (const flowRef of new Set(endpoints.map((endpoint) => endpoint.flowRef).filter(Boolean) as string[])) {
    const llm = await findLlmNodes(api, flows, [flowRef]);
    let aiAgent: string | undefined;
    const job = llm.find((node) => node.nodeType === 'aiAgentJob');
    if (job) {
      const detail = await api.node(job.flowId, job.nodeId);
      aiAgent = agentByRef.get(String(detail.config.aiAgent ?? ''))?.name;
    }
    flowInfo.set(flowRef, { aiAgent, llmNodes: llm.length });
  }

  const groups = new Map<string, Suggestion>();
  for (const endpoint of endpoints) {
    const info = endpoint.flowRef ? flowInfo.get(endpoint.flowRef) : undefined;
    const key = info?.aiAgent ? `ai:${info.aiAgent}` : `ep:${endpoint.id}`;
    const name = info?.aiAgent ?? endpoint.name;
    const owner = endpointOwner(existing, endpoint.id);
    const entry = groups.get(key) ?? {
      id: slugify(name),
      name,
      aiAgent: info?.aiAgent,
      endpoints: [],
      llmNodes: 0,
      noFlow: !endpoint.flowRef || !knownFlows.has(endpoint.flowRef),
    };
    entry.endpoints.push({ id: endpoint.id, name: endpoint.name, flowRef: endpoint.flowRef, channel: endpoint.channel });
    entry.llmNodes += info?.llmNodes ?? 0;
    if (owner) entry.ownedBy = owner.id;
    groups.set(key, entry);
  }

  return [...groups.values()].sort(
    (a, b) => Number(a.noFlow) - Number(b.noFlow) || b.llmNodes - a.llmNodes || a.name.localeCompare(b.name),
  );
}
