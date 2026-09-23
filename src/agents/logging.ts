/**
 * Switching on LLM logging in Cognigy, from here.
 *
 * Every AI Agent and LLM Prompt node reachable from an agent's endpoints gets
 * its logging pointed at this agent's webhook, with the agent's secret as a
 * header. Two rules keep this safe on a live project:
 *
 * - **A node is written whole.** The API does not say whether a config PATCH
 *   merges or replaces, so the node is read, only the logging fields change,
 *   and the complete configuration is written back. Under either behaviour
 *   every other setting survives. What the logging fields held before is kept,
 *   and uninstall puts exactly that back.
 * - **A node already logging somewhere else is not taken silently.** A node has
 *   one webhook; pointing it here cuts off whatever received it before. That
 *   needs an explicit take-over.
 *
 * `loggingCustomData` and `conditionForLogging` are left alone. The agent is
 * identified by the webhook path, which this module generates, and a sampling
 * condition the owner set is theirs to keep.
 */
import type { CognigyApi } from '../cognigy/api.ts';
import type { Store } from '../store/db.ts';
import type { Agent, LoggingInstall } from './model.ts';
import { findLlmNodes, type LlmNode } from './nodes.ts';

export type LoggingState = 'ours' | 'other' | 'off';

export interface NodeLogging extends LlmNode {
  state: LoggingState;
  /** Where the node posts now, when it posts somewhere else. */
  currentUrl?: string;
}

type Api = Pick<CognigyApi, 'flows' | 'flowNodes' | 'node' | 'updateNodeConfig'>;

/** The URL a node posts to. Cognigy fills the placeholders per call. */
export function hookUrl(publicUrl: string, agentId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/hook/${encodeURIComponent(agentId)}` +
    '?userId={{input.userId}}&sessionId={{input.sessionId}}';
}

/** Whether a webhook URL is this agent's own — by exact path, never by prefix. */
function pointsAt(url: string, agent: Agent): boolean {
  // `/hook/summit` is a prefix of `/hook/summit-2`; a substring test would let one
  // agent claim, and on uninstall cut off, another agent's nodes.
  const id = encodeURIComponent(agent.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`/hook/${id}(?:[?#]|$)`).test(url);
}

function isOurs(config: Record<string, unknown>, agent: Agent): boolean {
  return config.advancedLogging === true && pointsAt(String(config.loggingWebhookUrl ?? ''), agent);
}

/**
 * What a node's logging fields go back to. A field the node never had comes
 * back as "off" rather than as absent: the agent is stored as JSON, which drops
 * undefined values, so an absent "before" would otherwise leave our own logging
 * switched on after an uninstall that reported success.
 */
function restored(previous: LoggingInstall['previous']) {
  return {
    advancedLogging: previous.advancedLogging ?? false,
    loggingWebhookUrl: previous.loggingWebhookUrl ?? '',
    loggingHeaders: previous.loggingHeaders ?? '{}',
  };
}

function stateOf(config: Record<string, unknown>, agent: Agent): LoggingState {
  if (isOurs(config, agent)) return 'ours';
  return config.advancedLogging === true && String(config.loggingWebhookUrl ?? '').trim() ? 'other' : 'off';
}

/** Every LLM node the agent's traffic reaches, and what its logging does now. */
export async function loggingStatus(agent: Agent, api: Api): Promise<NodeLogging[]> {
  const flows = await api.flows(agent.projectId);
  const entry = agent.endpoints.map((endpoint) => endpoint.flowRef).filter(Boolean) as string[];
  const nodes = await findLlmNodes(api, flows, entry);
  const out: NodeLogging[] = [];
  for (const node of nodes) {
    const { config } = await api.node(node.flowId, node.nodeId);
    const state = stateOf(config, agent);
    out.push({ ...node, state, ...(state === 'other' ? { currentUrl: String(config.loggingWebhookUrl) } : {}) });
  }
  return out;
}

/** Whether a node of ours already posts to exactly this URL with this token. */
function isCurrent(config: Record<string, unknown>, url: string, token: string): boolean {
  if (config.loggingWebhookUrl !== url) return false;
  try {
    return JSON.parse(String(config.loggingHeaders ?? '{}'))['X-Webhook-Token'] === token;
  } catch {
    return false;
  }
}

export interface InstallReport {
  installed: NodeLogging[];
  alreadyOurs: NodeLogging[];
  /** Logging to somewhere else, left alone because take-over was not asked for. */
  skipped: NodeLogging[];
  failed: { node: NodeLogging; error: string }[];
}

export async function installLogging(
  agent: Agent,
  api: Api,
  store: Pick<Store, 'saveAgent'>,
  options: { publicUrl: string | undefined; takeOver?: boolean; onlyNodeIds?: string[] },
): Promise<{ agent: Agent; report: InstallReport }> {
  if (!options.publicUrl?.trim()) {
    throw new Error(
      'No public URL for Cognigy to post to. Set AGENT_WATCH_PUBLIC_URL to the tunnel address, ' +
        'for example https://agentwatch.example.com',
    );
  }
  const url = hookUrl(options.publicUrl, agent.id);
  const headers = JSON.stringify({ 'X-Webhook-Token': agent.trace.token }, null, 2);
  const report: InstallReport = { installed: [], alreadyOurs: [], skipped: [], failed: [] };
  const installs = new Map(agent.trace.installs.map((install) => [install.nodeId, install]));

  for (const node of await loggingStatus(agent, api)) {
    if (options.onlyNodeIds && !options.onlyNodeIds.includes(node.nodeId)) continue;
    // Ours by path, but a tunnel's address changes when it restarts: a node
    // still posting to the old host, or with an old token, is written again.
    if (node.state === 'ours' && isCurrent((await api.node(node.flowId, node.nodeId)).config, url, agent.trace.token)) {
      report.alreadyOurs.push(node);
      continue;
    }
    if (node.state === 'other' && !options.takeOver) {
      report.skipped.push(node);
      continue;
    }
    try {
      const { config } = await api.node(node.flowId, node.nodeId);
      const previous = {
        advancedLogging: config.advancedLogging,
        loggingWebhookUrl: config.loggingWebhookUrl,
        loggingHeaders: config.loggingHeaders,
      };
      await api.updateNodeConfig(node.flowId, node.nodeId, {
        ...config,
        advancedLogging: true,
        loggingWebhookUrl: url,
        // A JSON *string*, as the node stores it — not an object.
        loggingHeaders: headers,
      });
      const after = await api.node(node.flowId, node.nodeId);
      if (!isOurs(after.config, agent)) throw new Error('the node did not keep the new logging settings');

      const install: LoggingInstall = {
        flowId: node.flowId, flowName: node.flowName, nodeId: node.nodeId, nodeType: node.nodeType,
        nodeLabel: node.nodeLabel, installedAt: new Date().toISOString(),
        // A re-install keeps the original "before", not our own earlier settings.
        previous: installs.get(node.nodeId)?.previous ?? previous,
      };
      installs.set(node.nodeId, install);
      report.installed.push({ ...node, state: 'ours' });
    } catch (error) {
      report.failed.push({ node, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const next = { ...agent, trace: { ...agent.trace, installs: [...installs.values()] } };
  store.saveAgent(next);
  return { agent: next, report };
}

export interface UninstallReport {
  restored: LoggingInstall[];
  /** Changed by someone else since install — not ours to overwrite. */
  leftAlone: LoggingInstall[];
  failed: { install: LoggingInstall; error: string }[];
}

export async function uninstallLogging(
  agent: Agent,
  api: Api,
  store: Pick<Store, 'saveAgent'>,
): Promise<{ agent: Agent; report: UninstallReport }> {
  const report: UninstallReport = { restored: [], leftAlone: [], failed: [] };
  const remaining: LoggingInstall[] = [];

  for (const install of agent.trace.installs) {
    try {
      const { config } = await api.node(install.flowId, install.nodeId);
      if (!isOurs(config, agent)) {
        report.leftAlone.push(install);
        continue;
      }
      await api.updateNodeConfig(install.flowId, install.nodeId, { ...config, ...restored(install.previous) });
      // Checked, as install is: a restore the node did not keep is not a restore.
      const after = await api.node(install.flowId, install.nodeId);
      if (isOurs(after.config, agent)) throw new Error('the node still logs to this agent after the restore');
      report.restored.push(install);
    } catch (error) {
      report.failed.push({ install, error: error instanceof Error ? error.message : String(error) });
      remaining.push(install);
    }
  }

  const next = { ...agent, trace: { ...agent.trace, installs: remaining } };
  store.saveAgent(next);
  return { agent: next, report };
}
