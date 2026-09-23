/**
 * Finding the nodes that call an LLM, starting from where traffic enters.
 *
 * An endpoint enters one Flow, but the LLM work often happens in another Flow
 * reached through a Go To or Execute Flow node. Logging installed only on the
 * entry Flow would miss it, so this follows those links, once per Flow.
 */
import type { CognigyApi, CognigyFlow } from '../cognigy/api.ts';

export const LLM_NODE_TYPES = new Set(['aiAgentJob', 'llmPromptV2']);
const LINK_NODE_TYPES = new Set(['goTo', 'executeFlow']);
/** A guard against a pathological Flow graph. */
const MAX_FLOWS = 40;

export interface LlmNode {
  flowId: string;
  flowRef: string;
  flowName: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
}

type Api = Pick<CognigyApi, 'flowNodes' | 'node'>;

export async function findLlmNodes(api: Api, flows: CognigyFlow[], entryFlowRefs: string[]): Promise<LlmNode[]> {
  const byRef = new Map(flows.map((flow) => [flow.referenceId, flow]));
  const queue = [...new Set(entryFlowRefs)];
  const seen = new Set<string>();
  const found: LlmNode[] = [];

  while (queue.length && seen.size < MAX_FLOWS) {
    const ref = queue.shift()!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const flow = byRef.get(ref);
    if (!flow) continue;

    for (const node of await api.flowNodes(flow.id)) {
      if (LLM_NODE_TYPES.has(node.type)) {
        found.push({
          flowId: flow.id, flowRef: flow.referenceId, flowName: flow.name,
          nodeId: node.id, nodeType: node.type, nodeLabel: node.label,
        });
      } else if (LINK_NODE_TYPES.has(node.type)) {
        const detail = await api.node(flow.id, node.id);
        const target = (detail.config.flowNode as { flow?: unknown } | undefined)?.flow;
        if (typeof target === 'string' && !seen.has(target)) queue.push(target);
      }
    }
  }
  return found;
}
