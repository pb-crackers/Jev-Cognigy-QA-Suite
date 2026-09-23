/**
 * The Agent Watch HTTP routes, over a real local server with an in-memory
 * store and a fake Cognigy. No network beyond localhost.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store/db.ts';
import { LIBRARY_RUBRICS } from '../src/rubrics/library.ts';

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
    assert.deepEqual(body, { imported: 3, skipped: 0 });
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
