/**
 * The Agent Watch HTTP routes, over a real local server with an in-memory
 * store and a fake Cognigy. No network beyond localhost.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store/db.ts';
import { LIBRARY_RUBRICS } from '../src/rubrics/library.ts';
import { locateKey } from '../src/scoring/locate.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const configs: Record<string, Record<string, unknown>> = {
  job: { aiAgent: 'ref', advancedLogging: false, loggingWebhookUrl: '', loggingHeaders: '{}' },
};
const cognigy = {
  async endpoints() { return [{ id: 'e-rest', name: 'REST', flowRef: 'ref-main' }]; },
  async flows() { return [{ id: 'f1', referenceId: 'ref-main', name: 'Main' }]; },
  async aiAgents() { return [{ id: 'a', referenceId: 'ref', name: 'Home Loans Assistant' }]; },
  async flowNodes() { return [{ id: 'job', type: 'aiAgentJob', label: 'AI Agent' }]; },
  async node(_f: string, id: string) { return { id, type: 'aiAgentJob', label: 'AI Agent', config: structuredClone(configs[id]) }; },
  async updateNodeConfig(_f: string, id: string, config: Record<string, unknown>) { configs[id] = structuredClone(config); },
  async projects() { return []; },
};

let base: string;
let store: Store;
let close: () => void;

before(async () => {
  store = new Store(':memory:');
  LIBRARY_RUBRICS.forEach((rubric, index) => store.saveRubric(rubric, index));
  const server = createApp({
    config: { typesafeApiKey: 'x', cognigyApiBase: 'https://api-x.example.com', cognigyApiKey: 'x',
      cognigyOdataBase: 'https://odata-x.example.com', publicUrl: 'https://agentwatch.example.com' },
    api: cognigy as never,
    odata: {} as never,
    store,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => {
  close();
  store.close();
});

const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(base + path, {
    ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

describe('agents over HTTP', () => {
  it('suggests agents from the project', async () => {
    const { status, body } = await call('/api/agents/suggest?projectId=p1');
    assert.equal(status, 200);
    assert.equal(body[0].name, 'Home Loans Assistant');
  });

  it('refuses an invalid agent with every problem listed', async () => {
    const { status, body } = await call('/api/agents', { method: 'POST', body: JSON.stringify({ name: '' }) });
    assert.equal(status, 400);
    assert.ok(body.problems.length >= 2);
  });

  it('creates an agent and lists it with its health and webhook', async () => {
    const created = await call('/api/agents', { method: 'POST', body: JSON.stringify({
      name: 'Home Loans', projectId: 'p1', endpoints: [{ id: 'e-rest', name: 'REST', flowRef: 'ref-main' }],
    }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.hookUrl, 'https://agentwatch.example.com/hook/home-loans?userId={{input.userId}}&sessionId={{input.sessionId}}');
    const list = await call('/api/agents');
    assert.equal(list.body[0].agent.id, 'home-loans');
    assert.equal(list.body[0].health.sessions, 0);
  });

  it('updates an agent\'s switches', async () => {
    const { status } = await call('/api/agents/home-loans', { method: 'PATCH', body: JSON.stringify({ rubrics: { jailbroken: false } }) });
    assert.equal(status, 200);
    assert.equal(store.agent('home-loans')!.rubrics.jailbroken, false);
  });

  it('reports data health with the agent, and a problem count in the fleet', async () => {
    const detail = await call('/api/agents/home-loans');
    assert.deepEqual(Object.keys(detail.body.data).sort(), ['drift', 'failed', 'failedCalls', 'gaps', 'logged', 'problems', 'sessions', 'unscoreable']);
    const list = await call('/api/agents');
    assert.equal(list.body[0].dataProblems, 0);
  });

  it("lists an agent's sessions and a rubric's sessions, and refuses a filter it doesn't know", async () => {
    const list = await call('/api/agents/home-loans/sessions?show=all');
    assert.equal(list.status, 200);
    assert.deepEqual(Object.keys(list.body.counts).sort(), ['all', 'call_failed', 'not_scored', 'rubric_failed']);
    assert.equal((await call('/api/agents/home-loans/sessions?show=everything')).status, 400);
    const rubric = await call('/api/agents/home-loans/rubrics/jailbroken?show=failed');
    assert.equal(rubric.status, 200);
    assert.equal(rubric.body.rubric.id, 'jailbroken');
    assert.deepEqual(rubric.body.counts, { failed: 0, passed: 0, all: 0 });
    assert.equal((await call('/api/agents/home-loans/rubrics/nope')).status, 404);
    store.saveRubric({ id: 'no-rate-quotes', name: 'No rate quotes', question: 'Did the agent quote a rate?', type: 'boolean', combine: 'any', weight: 1, enabled: true, origin: 'custom' });
    const hyphenated = await call('/api/agents/home-loans/rubrics/no-rate-quotes?show=all');
    assert.equal(hyphenated.status, 200, 'a rubric id is whatever its author chose');
    assert.equal(hyphenated.body.rubric.id, 'no-rate-quotes');
  });

  it('finds the message behind an answer once, then serves it from what was stored', async () => {
    store.saveRun({ id: 'loc-run', startedAt: new Date().toISOString(), projectId: 'p1', projectName: 'P', endpointLabel: 'REST',
      fromTs: 'a', toTs: 'b', sessions: 1, costUsd: 0, ms: 0, agentId: 'home-loans' });
    store.saveSession({ runId: 'loc-run', sessionId: 'loc-1', startedAt: new Date().toISOString(), endpointLabel: 'REST', channel: 'rest',
      channelLabel: 'REST API', flowName: 'Main', turns: 2, chunks: 1, rating: null, ratingComment: null, unscoreable: null,
      transcript: JSON.stringify([{ role: 'user', text: 'hi', at: 't' }, { role: 'agent', text: 'hello', at: 't' }]), costUsd: 0, ms: 0 },
    [{ runId: 'loc-run', sessionId: 'loc-1', rubricId: 'jailbroken', raw: '0.1', confidence: null, chunks: 1, decidedBy: null }]);
    const ask = (body: object) => call('/api/sessions/loc-1/locate', { method: 'POST', body: JSON.stringify(body) });

    assert.equal((await ask({ agentId: 'home-loans', rubricId: 'nope' })).status, 404);
    const unanswered = await ask({ agentId: 'home-loans', rubricId: 'harmful_content' });
    assert.equal(unanswered.status, 409);
    assert.match(unanswered.body.error, /no answer for this session yet/);

    const jailbroken = store.rubrics().find((rubric) => rubric.id === 'jailbroken')!;
    const key = locateKey(jailbroken, '0.1', [{ role: 'user' }, { role: 'agent' }]);
    store.saveLocate('home-loans', 'loc-1', 'jailbroken', { raw: '0.1', key, turnIndex: null, message: null, confidence: 0.8, reason: 'no single message decides this one' });
    const stored = await ask({ agentId: 'home-loans', rubricId: 'jailbroken' });
    assert.equal(stored.status, 200);
    assert.equal(stored.body.cached, true);
    assert.equal(stored.body.reason, 'no single message decides this one');
  });

  it('asks which session to score before retrying', async () => {
    const { status, body } = await call('/api/agents/home-loans/retry', { method: 'POST', body: '{}' });
    assert.equal(status, 400);
    assert.match(body.error, /which session/);
  });

  it('only holds simulated conversations in demo mode', async () => {
    const { status, body } = await call('/api/agents/home-loans/simulate', { method: 'POST', body: '{}' });
    assert.equal(status, 403);
    assert.match(body.error, /demo mode/);
    const fleet = await call('/api/simulate', { method: 'POST', body: '{}' });
    assert.equal(fleet.status, 403);
    const watch = await call('/api/watch');
    assert.equal(watch.body.demo, false);
    assert.deepEqual(watch.body.feed, []);
  });
});

describe('the webhook', () => {
  it('accepts a trace with the agent\'s token and refuses one without', async () => {
    const token = store.agent('home-loans')!.trace.token;
    const denied = await fetch(`${base}/hook/home-loans`, { method: 'POST', body: fixture('trace-greeting.json') });
    assert.equal(denied.status, 401);
    const accepted = await fetch(`${base}/hook/home-loans?userId=u&sessionId=sess-1`, {
      method: 'POST', headers: { 'x-webhook-token': token }, body: fixture('trace-greeting.json'),
    });
    assert.equal(accepted.status, 204);
    assert.equal(store.traceSummary('home-loans').traces, 1);
  });

  it('refuses a body too large to be a single LLM call, and keeps serving afterwards', async () => {
    const token = store.agent('home-loans')!.trace.token;
    const huge = JSON.stringify({ meta: { sessionId: 's' }, pad: 'x'.repeat(6 * 1024 * 1024) });
    // A client still uploading may see the 413 or a closed connection; both are a refusal.
    const outcome = await fetch(`${base}/hook/home-loans`, { method: 'POST', headers: { 'x-webhook-token': token }, body: huge })
      .then((response) => response.status, () => 'closed');
    assert.ok(outcome === 413 || outcome === 'closed', `refused (${outcome})`);
    assert.equal(store.traceSummary('home-loans').traces, 1, 'nothing was stored');
    // What the connection handling protects: the next request is answered normally.
    const next = await call('/api/agents');
    assert.equal(next.status, 200);
  });

  it('imports traces captured elsewhere', async () => {
    const { body } = await call('/api/agents/home-loans/traces/import', { method: 'POST', body: fixture('trace-session.json') });
    // The greeting posted to the webhook above is this session's first call, so it isn't stored twice.
    assert.deepEqual(body, { imported: 2, duplicates: 1, skipped: 0 });
  });
});

describe('logging over HTTP', () => {
  it('reports the nodes, installs, and removes logging', async () => {
    const status = await call('/api/agents/home-loans/logging');
    assert.deepEqual(status.body.nodes.map((node: { state: string }) => node.state), ['off']);

    const installed = await call('/api/agents/home-loans/logging', { method: 'POST', body: '{}' });
    assert.equal(installed.body.installed.length, 1);
    assert.equal(configs.job.advancedLogging, true);

    const removed = await call('/api/agents/home-loans/logging', { method: 'DELETE' });
    assert.equal(removed.body.restored.length, 1);
    assert.equal(configs.job.advancedLogging, false);
  });

  it('takes logging out before deleting an agent', async () => {
    await call('/api/agents/home-loans/logging', { method: 'POST', body: '{}' });
    const { status, body } = await call('/api/agents/home-loans', { method: 'DELETE' });
    assert.equal(status, 200);
    assert.equal(body.uninstall.restored.length, 1);
    assert.equal(configs.job.advancedLogging, false);
    assert.equal(store.agent('home-loans'), undefined);
  });
});

describe('exposure through a tunnel', () => {
  it('refuses every route but the webhook when the request came through a tunnel', async () => {
    const tunnelled = { host: 'agentwatch.example.com', 'cf-connecting-ip': '203.0.113.9' };
    for (const path of ['/api/agents', '/api/alerts', '/', '/api/agents/anyone/logging']) {
      const response = await fetch(base + path, { headers: tunnelled });
      assert.equal(response.status, 403, path);
    }
  });

  it('refuses a request with a public host name even without forwarding headers', async () => {
    // fetch will not send a Host header of your choosing; node:http will.
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/api/agents`, { headers: { host: 'agentwatch.example.com' } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 403);
  });

  it('still lets the webhook through, where the token does the checking', async () => {
    const response = await fetch(`${base}/hook/nobody`, {
      method: 'POST', headers: { host: 'agentwatch.example.com', 'cf-connecting-ip': '203.0.113.9' }, body: '{}',
    });
    assert.equal(response.status, 404, 'reached the receiver, which knows no such agent');
  });
});

describe('alerts and validity over HTTP', () => {
  it('lists alerts with readable names', async () => {
    const { status, body } = await call('/api/alerts');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('returns stored validity reports', async () => {
    store.saveValidity('jailbroken', { validity: 0.8 }, '2026-09-23T00:00:00Z');
    const { body } = await call('/api/validity');
    assert.equal(body.jailbroken.validity, 0.8);
  });

  it('answers 404 for an unknown agent', async () => {
    assert.equal((await call('/api/agents/nobody')).status, 404);
  });
});
