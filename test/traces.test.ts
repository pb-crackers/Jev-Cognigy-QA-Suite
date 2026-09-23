/**
 * Receiving, storing and reconstructing Cognigy's logged LLM calls, from
 * sanitised fixtures shaped like a real payload. No network.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createAgent } from '../src/agents/service.ts';
import { unwrapTrace } from '../src/traces/model.ts';
import { importTraces, receiveTrace } from '../src/traces/receiver.ts';
import { reconstruct, traceCoverage } from '../src/traces/reconstruct.ts';
import { Store } from '../src/store/db.ts';
import type { Turn } from '../src/cognigy/transcript.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function withAgent() {
  const store = new Store(':memory:');
  const agent = createAgent({ name: 'Home Loans', projectId: 'p1', endpoints: [{ id: 'e', name: 'REST' }] }, store, []);
  return { store, agent };
}

describe('the webhook receiver', () => {
  it('stores a trace posted with the right token', () => {
    const { store, agent } = withAgent();
    const result = receiveTrace(store, agent.id, { 'x-webhook-token': agent.trace.token }, JSON.stringify(fixture('trace-greeting.json')));
    assert.equal(result.status, 204);
    const [stored] = store.tracesFor(agent.id, 'sess-1');
    assert.equal(stored.inputId, 'in-1');
    assert.equal(stored.eventAt, '2026-09-23T00:18:20.009Z');
    store.close();
  });

  it('refuses a missing or wrong token without storing anything', () => {
    const { store, agent } = withAgent();
    const body = JSON.stringify(fixture('trace-greeting.json'));
    assert.equal(receiveTrace(store, agent.id, {}, body).status, 401);
    assert.equal(receiveTrace(store, agent.id, { 'x-webhook-token': 'guess' }, body).status, 401);
    assert.equal(store.tracesFor(agent.id, 'sess-1').length, 0);
    store.close();
  });

  it('answers 404 for an agent that does not exist', () => {
    const { store } = withAgent();
    assert.equal(receiveTrace(store, 'nobody', { 'x-webhook-token': 'x' }, '{}').status, 404);
    store.close();
  });

  it('rejects a body that is not JSON, or has no session', () => {
    const { store, agent } = withAgent();
    const headers = { 'x-webhook-token': agent.trace.token };
    assert.equal(receiveTrace(store, agent.id, headers, 'not json').status, 400);
    assert.equal(receiveTrace(store, agent.id, headers, JSON.stringify({ meta: {} })).status, 400);
    store.close();
  });
});

describe('unwrapping', () => {
  it('reads a relay envelope the same as a direct post', () => {
    const direct = unwrapTrace(fixture('trace-greeting.json'))!;
    const wrapped = unwrapTrace(fixture('trace-envelope.json'))!;
    assert.deepEqual(wrapped, direct);
  });

  it('falls back to the query string for the session id', () => {
    const envelope = fixture('trace-envelope.json');
    delete envelope.body.meta.sessionId;
    assert.equal(unwrapTrace(envelope)?.meta.sessionId, 'sess-1');
  });

  it('imports an array and counts what it could not read', () => {
    const { store, agent } = withAgent();
    const result = importTraces(store, agent.id, [...fixture('trace-session.json'), { nothing: true }]);
    assert.deepEqual(result, { imported: 3, skipped: 1 });
    assert.equal(store.traceSummary(agent.id).traces, 3);
    store.close();
  });
});

describe('reconstruction', () => {
  function sessionTraces() {
    const { store, agent } = withAgent();
    importTraces(store, agent.id, fixture('trace-session.json'));
    const traces = store.tracesFor(agent.id, 'sess-1');
    store.close();
    return traces;
  }

  it('recovers the instructions exactly as sent', () => {
    const trace = reconstruct(sessionTraces());
    assert.match(trace.instructions!, /^You are an AI Agent/);
    assert.match(trace.instructions!, /Any payment figure comes from estimate_payment/);
  });

  it('lists the tools the agent had', () => {
    assert.deepEqual(reconstruct(sessionTraces()).tools.map((tool) => tool.name), ['estimate_payment', 'check_eligibility']);
  });

  it('pairs a tool call with its result, once, in order', () => {
    const events = reconstruct(sessionTraces()).events;
    assert.deepEqual(events.map((event) => `${event.kind}:${event.name}`), ['call:estimate_payment', 'result:estimate_payment']);
    assert.match(events[0].detail, /"homePrice":400000/);
    assert.match(events[1].detail, /"total":2912/);
    assert.equal(events[0].inputId, 'in-2');
  });

  it('adds up the agent\'s own token use across calls', () => {
    const trace = reconstruct(sessionTraces());
    assert.equal(trace.calls, 3);
    assert.equal(trace.tokens.input, 3 * 2786);
  });

  it('accepts the flat tool-call shape as well as the nested one', () => {
    const traces = sessionTraces();
    traces[1].payload.response!.toolCalls = [{ id: 'c9', name: 'check_eligibility', arguments: '{"creditScore":700}' }];
    const call = reconstruct(traces).events.find((event) => event.kind === 'call');
    assert.equal(call?.name, 'check_eligibility');
  });
});

describe('trace coverage', () => {
  const turn = (role: Turn['role'], inputId: string, nodeType?: string): Turn => ({ role, text: 'x', at: 't', inputId, nodeType });
  const trace = { inputIds: new Set(['in-1', 'in-2']) };

  it('is full when every LLM-produced agent turn has a logged call', () => {
    assert.equal(traceCoverage([turn('user', 'in-1'), turn('agent', 'in-1', 'aiAgentJob'), turn('agent', 'in-2', 'aiAgentJob')], trace), 'full');
  });

  it('ignores agent turns from nodes that never call a model', () => {
    assert.equal(traceCoverage([turn('agent', 'in-9', 'say'), turn('agent', 'in-1', 'llmPromptV2')], trace), 'full');
  });

  it('is partial when an LLM turn has no logged call — logging is per node', () => {
    assert.equal(traceCoverage([turn('agent', 'in-1', 'aiAgentJob'), turn('agent', 'in-3', 'llmPromptV2')], trace), 'partial');
  });

  it('is none with no traces at all', () => {
    assert.equal(traceCoverage([turn('agent', 'in-1', 'aiAgentJob')], undefined), 'none');
  });
});
