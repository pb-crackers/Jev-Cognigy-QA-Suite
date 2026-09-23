/**
 * The HTTP surface for Agent Watch: agents, their logging, health, alerts,
 * validity, coverage — and the webhook Cognigy posts logged LLM calls to.
 *
 * Kept apart from the batch-QA routes in server.ts. Every route returns plain
 * JSON; the rules live in the modules it calls, so the CLI enforces them too.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CognigyApi } from './cognigy/api.ts';
import type { OdataClient } from './cognigy/odata.ts';
import type { Config } from './config.ts';
import type { Store } from './store/db.ts';
import { AgentError, agentRunRequest, createAgent, updateAgent, type AgentInput } from './agents/service.ts';
import { suggestAgents } from './agents/suggest.ts';
import { hookUrl, installLogging, loggingStatus, uninstallLogging } from './agents/logging.ts';
import { collectAgent, type CollectReport } from './collector/collect.ts';
import type { Scheduler } from './collector/scheduler.ts';
import { computeHealth, WINDOW_DAYS, type HealthWindow } from './health/health.ts';
import { computeDataHealth } from './health/data.ts';
import { rubricSessions, sessionList, type SessionFilter, type VerdictFilter } from './health/drilldown.ts';
import { executeRun } from './scoring/run.ts';
import { placeToolCalls } from './traces/place.ts';
import { locateSession } from './scoring/locate.ts';
import type { Turn } from './cognigy/transcript.ts';
import { checkCoverage } from './validity/coverage.ts';
import { checkValidity, type ValidityReport } from './validity/validity.ts';
import { importTraces, MAX_TRACE_BYTES, receiveTrace } from './traces/receiver.ts';
import { scoreSessions } from './store/score.ts';
import { labelFor } from './cognigy/channels.ts';
import { agentRubrics, type Agent } from './agents/model.ts';
import { cast, endpointBase, personasFor, restEndpoint, simulate, type TurnEvent } from './demo/simulate.ts';

/**
 * Whether a request came from this machine rather than through a tunnel.
 *
 * Agent Watch is exposed to Cognigy through a tunnel so it can receive logged
 * LLM calls, and only the webhook authenticates. Everything else — transcripts,
 * paid scoring runs, deleting agents, rewriting live Cognigy node logging — must
 * be reachable only from this machine. A tunnel forwards the public host name
 * and adds forwarding headers, so both are checked; either gives it away.
 */
export function isLocalRequest(headers: IncomingMessage['headers']): boolean {
  if (headers['cf-connecting-ip'] || headers['x-forwarded-for'] || headers['forwarded']) return false;
  const host = String(headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export interface WatchDeps {
  config: Config;
  api: CognigyApi;
  odata: OdataClient;
  store: Store;
  scheduler?: Scheduler;
  /** Demo mode: fast collection, and the UI refreshes often enough to watch it happen. */
  demo?: boolean;
  /** Simulated conversation turns, newest first, for the live feed. */
  feed?: (TurnEvent & { at: string; agentId: string })[];
}

const FEED = 80;

/**
 * Starts an agent's simulated customers in the background — the conversations
 * take a minute or two, and the page watches them arrive through the feed.
 * Returns who was started, or why nobody could be.
 */
function startSimulation(deps: WatchDeps, agent: Agent, count?: number, only?: string[]): { started: string[] } | { error: string } {
  const endpoint = restEndpoint(agent);
  const base = endpointBase(deps.config.cognigyApiBase, process.env.COGNIGY_ENDPOINT_BASE);
  if (!endpoint || !base) return { error: `${agent.name} has no REST endpoint to talk to, so it cannot be simulated.` };
  const set = personasFor(agent);
  const personas = cast(count ?? set.length, only, set);
  const feed = deps.feed ?? [];
  void simulate({
    url: `${base}/${endpoint.urlToken}`,
    personas,
    onTurn: (event) => {
      feed.unshift({ ...event, agentId: agent.id, at: new Date().toISOString() });
      feed.length = Math.min(feed.length, FEED);
    },
  });
  return { started: personas.map((persona) => persona.id) };
}

type Send = (status: number, body: unknown) => void;

class TooLarge extends Error {}

async function readText(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new TooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody<T>(request: IncomingMessage, limit = 1024 * 1024): Promise<T> {
  const text = await readText(request, limit);
  return (text ? JSON.parse(text) : {}) as T;
}

function asWindow(value: string | null): HealthWindow {
  return value && value in WINDOW_DAYS ? (value as HealthWindow) : '24h';
}

/** What the fleet list needs about one agent, without the per-session detail. */
function agentSummary(deps: WatchDeps, agentId: string, window: HealthWindow) {
  const { store } = deps;
  const agent = store.agent(agentId)!;
  const health = computeHealth(agent, store.rubrics(), store, window);
  return {
    agent,
    state: store.agentState(agentId),
    traces: store.traceSummary(agentId),
    health: {
      window: health.window, sessions: health.sessions, health: health.health, interval: health.interval,
      reportable: health.reportable, verifiedShare: health.verifiedShare, alerts: health.alerts, traced: health.traced,
    },
    hookUrl: deps.config.publicUrl ? hookUrl(deps.config.publicUrl, agentId) : null,
    dataProblems: computeDataHealth(agentId, store, window).problems,
  };
}

async function collect(deps: WatchDeps, agentId: string): Promise<CollectReport> {
  return deps.scheduler
    ? deps.scheduler.collectNow(agentId)
    : collectAgent(agentId, { api: deps.api, odata: deps.odata, store: deps.store });
}

/** Handles an Agent Watch route. Returns false when the path is not one of them. */
export async function handleWatchRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: WatchDeps,
  send: Send,
): Promise<boolean> {
  const { store, api, config } = deps;
  const method = request.method ?? 'GET';
  const path = url.pathname;

  try {
    // ---- the webhook ----
    const hook = path.match(/^\/hook\/([\w-]+)$/);
    if (hook) {
      if (method !== 'POST') return send(405, { error: 'POST only' }), true;
      let raw: string;
      try {
        raw = await readText(request, MAX_TRACE_BYTES);
      } catch (error) {
        if (!(error instanceof TooLarge)) throw error;
        // The rest of the body is still on the socket. Leaving the connection open
        // would hand that unread upload to the next request on it; `connection:
        // close` makes Node end the socket once the answer is out, so it is never
        // reused.
        response.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ error: 'Trace too large' }));
        return true;
      }
      const result = receiveTrace(store, hook[1], request.headers, raw);
      if (result.status === 204) {
        response.writeHead(204);
        response.end();
      } else send(result.status, result.body);
      return true;
    }

    if (!path.startsWith('/api/agents') && !path.startsWith('/api/alerts') &&
        !path.startsWith('/api/validity') && !path.startsWith('/api/sessions/') && path !== '/api/watch' && path !== '/api/simulate') {
      return false;
    }

    if (path === '/api/watch') {
      const names = new Map(store.agents().map((agent) => [agent.id, agent.name]));
      return send(200, {
        publicUrl: config.publicUrl ?? null,
        demo: Boolean(deps.demo),
        scheduler: deps.scheduler
          ? { running: true, collecting: deps.scheduler.collecting ? names.get(deps.scheduler.collecting) ?? deps.scheduler.collecting : null }
          : { running: false, collecting: null },
        recent: (deps.scheduler?.recent ?? []).map((report) => ({ ...report, agentName: names.get(report.agentId) ?? report.agentId })),
        feed: deps.feed ?? [],
      }), true;
    }

    if (path === '/api/simulate' && method === 'POST') {
      if (!deps.demo) return send(403, { error: 'Simulated conversations are only available in demo mode.' }), true;
      const started = store.agents().filter((agent) => agent.enabled && restEndpoint(agent))
        .map((agent) => ({ agentId: agent.id, ...startSimulation(deps, agent) }));
      if (started.length === 0) return send(409, { error: 'No watched agent has a REST endpoint to talk to.' }), true;
      return send(202, { started }), true;
    }

    // ---- agents ----
    if (path === '/api/agents' && method === 'GET') {
      const window = asWindow(url.searchParams.get('window'));
      return send(200, store.agents().map((agent) => agentSummary(deps, agent.id, window))), true;
    }
    if (path === '/api/agents' && method === 'POST') {
      const body = await readBody<AgentInput>(request);
      const agent = createAgent(body, store, store.rubrics());
      return send(201, agentSummary(deps, agent.id, '24h')), true;
    }
    if (path === '/api/agents/suggest') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return send(400, { error: 'projectId is required' }), true;
      return send(200, await suggestAgents(api, projectId, store.agents())), true;
    }

    // A rubric id is whatever its author chose, so the last segment takes any character but "/".
    const one = path.match(/^\/api\/agents\/([\w-]+)(?:\/(\w+)(?:\/([^/]+))?)?$/);
    if (one) {
      const [, id, action, rawSub] = one;
      const sub = rawSub === undefined ? undefined : decodeURIComponent(rawSub);
      const agent = store.agent(id);
      if (!agent) return send(404, { error: `No agent "${id}"` }), true;

      if (!action && method === 'GET') {
        const window = asWindow(url.searchParams.get('window'));
        return send(200, {
          ...agentSummary(deps, id, window),
          detail: computeHealth(agent, store.rubrics(), store, window),
          data: computeDataHealth(id, store, window),
          coverage: store.coverageFor(id) ?? null,
          alerts: store.alerts({ agentId: id, limit: 50 }),
        }), true;
      }
      if (!action && method === 'PATCH') {
        updateAgent(id, await readBody<Partial<AgentInput>>(request), store);
        return send(200, agentSummary(deps, id, '24h')), true;
      }
      if (!action && method === 'DELETE') {
        // Nodes still posting to a deleted agent's webhook would fail forever, so
        // its logging comes out first unless the caller says otherwise.
        let uninstall = null;
        if (agent.trace.installs.length && url.searchParams.get('keepLogging') !== '1') {
          uninstall = (await uninstallLogging(agent, api, store)).report;
          if (uninstall.failed.length) {
            return send(409, { error: 'Could not remove logging from every node; the agent was kept.', uninstall }), true;
          }
        }
        store.deleteAgent(id);
        return send(200, { deleted: id, uninstall }), true;
      }
      if (action === 'collect' && method === 'POST') return send(200, await collect(deps, id)), true;
      if (action === 'simulate' && method === 'POST') {
        if (!deps.demo) return send(403, { error: 'Simulated conversations are only available in demo mode.' }), true;
        const body = await readBody<{ count?: number; personas?: string[] }>(request);
        const result = startSimulation(deps, agent, body.count, body.personas);
        return send('error' in result ? 409 : 202, result), true;
      }
      if (action === 'logging' && method === 'GET') {
        return send(200, {
          publicUrl: config.publicUrl ?? null,
          hookUrl: config.publicUrl ? hookUrl(config.publicUrl, id) : null,
          nodes: await loggingStatus(agent, api),
          installs: agent.trace.installs,
        }), true;
      }
      if (action === 'logging' && method === 'POST') {
        const body = await readBody<{ takeOver?: boolean; nodeIds?: string[] }>(request);
        const { report } = await installLogging(agent, api, store, {
          publicUrl: config.publicUrl, takeOver: body.takeOver, onlyNodeIds: body.nodeIds,
        });
        return send(200, report), true;
      }
      if (action === 'logging' && method === 'DELETE') {
        return send(200, (await uninstallLogging(agent, api, store)).report), true;
      }
      if (action === 'sessions' && method === 'GET') {
        const show = (url.searchParams.get('show') ?? 'all') as SessionFilter;
        if (!['all', 'rubric_failed', 'call_failed', 'not_scored'].includes(show)) return send(400, { error: 'show must be all, rubric_failed, call_failed or not_scored' }), true;
        return send(200, sessionList(agent, store.rubrics(), store, asWindow(url.searchParams.get('window')), show)), true;
      }
      if (action === 'rubrics' && sub && method === 'GET') {
        const rubric = store.rubrics().find((candidate) => candidate.id === sub);
        if (!rubric) return send(404, { error: 'No such rubric' }), true;
        const show = (url.searchParams.get('show') ?? 'failed') as VerdictFilter;
        if (!['failed', 'passed', 'all'].includes(show)) return send(400, { error: 'show must be failed, passed or all' }), true;
        const window = asWindow(url.searchParams.get('window'));
        const health = computeHealth(agent, store.rubrics(), store, window).rubrics.find((entry) => entry.rubricId === rubric.id);
        return send(200, { rubric, health: health ?? null, ...rubricSessions(agent, rubric, store, window, show) }), true;
      }
      // Scores one failed session now, however many times it has failed before.
      if (action === 'retry' && method === 'POST') {
        const { sessionId } = await readBody<{ sessionId?: string }>(request);
        if (!sessionId) return send(400, { error: 'Say which session to score: { "sessionId": "…" }' }), true;
        const rubrics = store.rubrics();
        const now = new Date().toISOString();
        const retry = () => executeRun(
          { ...agentRunRequest(agent, rubrics, { from: now, to: now, limit: 1 }), retrySessionIds: [sessionId] },
          { odata: deps.odata, store, rubrics },
        );
        const outcome = deps.scheduler ? await deps.scheduler.exclusive(retry) : await retry();
        return send(200, { scored: outcome.scored.length, failed: outcome.failed }), true;
      }
      if (action === 'coverage' && method === 'POST') {
        return send(200, await checkCoverage(agent, store.rubrics(), store)), true;
      }
      if (action === 'traces' && sub === 'import' && method === 'POST') {
        const body = await readBody<unknown>(request, 50 * 1024 * 1024);
        return send(200, importTraces(store, id, body)), true;
      }
      return send(404, { error: 'No such agent action' }), true;
    }

    // ---- which message a verdict rests on: asked once per answer, then stored ----
    const locateMatch = path.match(/^\/api\/sessions\/([\w-]+)\/locate$/);
    if (locateMatch && method === 'POST') {
      const sessionId = locateMatch[1];
      const { agentId, rubricId } = await readBody<{ agentId?: string; rubricId?: string }>(request);
      const owner = agentId ? store.agent(agentId) : undefined;
      const rubric = store.rubrics().find((candidate) => candidate.id === rubricId);
      if (!owner || !rubric) return send(404, { error: 'Say which agent and rubric: { "agentId": "…", "rubricId": "…" }' }), true;
      const outcome = await locateSession(store, owner, rubric, sessionId);
      return send(outcome.status, 'located' in outcome ? outcome.located : { error: outcome.error }), true;
    }

    // ---- one session, merged across runs, for the drawer ----
    const session = path.match(/^\/api\/sessions\/([\w-]+)$/);
    if (session && method === 'GET') {
      const agentId = url.searchParams.get('agentId');
      const rows = agentId ? store.sessionRows(agentId, session[1]) : [];
      const newest = rows[0];
      if (!newest) return send(404, { error: 'No such session for this agent' }), true;
      // A failed attempt may not have got as far as reading the conversation; the
      // last one that did still shows it.
      const read = rows.find((candidate) => candidate.transcript !== '[]') ?? newest;
      const row = { ...newest, transcript: read.transcript, turns: read.turns };
      const rubrics = store.rubrics();
      const [scored] = scoreSessions([row], store.latestResults([row.sessionId]), rubrics);
      const toolCalls = store.toolCallsFor(agentId!, row.sessionId);
      const owner = store.agent(agentId!);
      return send(200, {
        ...row,
        agentId,
        // The rubrics this agent is graded on — another agent's custom rubric was never asked here.
        rubricIds: owner ? agentRubrics(owner, rubrics).map((rubric) => rubric.id) : null,
        channelKind: labelFor(row.channel).kind,
        composite: scored.composite ?? null,
        flagged: scored.flagged,
        results: Object.fromEntries(scored.results),
        checks: row.checks ? JSON.parse(row.checks) : null,
        toolCalls,
        // The conversation with each input's tool calls where they happened —
        // the same placement the grader read them in.
        // Sessions scored before tool calls had records kept them as lines; the records replace them.
        timeline: placeToolCalls((JSON.parse(row.transcript) as Turn[]).filter((turn) => !toolCalls.length || !turn.tool), toolCalls),
      }), true;
    }

    // ---- alerts and validity ----
    if (path === '/api/alerts' && method === 'GET') {
      const agentId = url.searchParams.get('agentId') ?? undefined;
      const names = new Map(store.agents().map((agent) => [agent.id, agent.name]));
      const rubricNames = new Map(store.rubrics().map((rubric) => [rubric.id, rubric.name]));
      return send(200, store.alerts({ agentId, limit: 200 }).map((alert) => ({
        ...alert, agentName: names.get(alert.agentId) ?? alert.agentId, rubricName: rubricNames.get(alert.rubricId) ?? alert.rubricId,
      }))), true;
    }
    if (path === '/api/validity' && method === 'GET') {
      return send(200, Object.fromEntries(store.validityReports<ValidityReport>())), true;
    }
    if (path === '/api/validity' && method === 'POST') {
      const body = await readBody<{ stability?: boolean; sample?: number }>(request);
      const { reports, ledger } = await checkValidity(store, store.rubrics(), body);
      return send(200, { reports, costUsd: ledger.totals().costUsd }), true;
    }
    return false;
  } catch (error) {
    if (error instanceof AgentError) return send(400, { error: error.message, problems: error.problems }), true;
    if (error instanceof SyntaxError) return send(400, { error: 'Body is not valid JSON' }), true;
    return send(500, { error: error instanceof Error ? error.message : String(error) }), true;
  }
}
