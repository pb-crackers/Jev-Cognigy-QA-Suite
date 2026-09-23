/**
 * The trace normaliser and session reconstruction, against real payloads
 * captured from live Cognigy agents (sanitised: ids, secrets and prompts
 * replaced) and against the shapes they varied in.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { normalise } from '../src/traces/normalise.ts';
import { reconstruct } from '../src/traces/reconstruct.ts';
import type { StoredTrace, TracePayload } from '../src/traces/model.ts';

const real = (name: string): TracePayload[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/real/${name}.traces.json`, import.meta.url), 'utf8'));
const stored = (payloads: TracePayload[]): StoredTrace[] => payloads.map((payload, index) => ({
  id: index + 1, agentId: 'a', sessionId: payload.meta.sessionId, inputId: payload.meta.inputId ?? null,
  eventAt: payload.meta.timestamp, receivedAt: payload.meta.timestamp, payload,
}));
const SESSIONS = ['payment-question', 'address-change', 'frustrated', 'first-time-buyer'];

describe('normalising real payloads', () => {
  it('reads every real payload without drift', () => {
    for (const name of SESSIONS) {
      for (const payload of real(name)) assert.deepEqual(normalise(payload).drift, [], name);
    }
  });

  it('reads tool arguments whether they arrive as a string or already parsed', () => {
    const payloads = real('payment-question');
    const response = payloads.map((payload) => normalise(payload).call).find((call) => call.toolCalls.length)!;
    const history = payloads.map((payload) => normalise(payload).call).flatMap((call) => call.history).find((message) => message.toolCalls.length)!;
    assert.equal(typeof (payloads.find((p) => p.response?.toolCalls?.length)!.response!.toolCalls![0].function!.arguments), 'object', 'the response sends an object');
    assert.deepEqual(response.toolCalls[0].args, history.toolCalls[0].args, 'both read the same');
    assert.equal(typeof history.toolCalls[0].argsRaw, 'string');
  });

  it('keeps what auditing needs: schemas, finish reason, per-call tokens, model and timing', () => {
    const call = normalise(real('address-change')[0]).call;
    assert.ok(call.tools.every((tool) => tool.parameters), 'every tool keeps its schema');
    assert.ok(call.finishReason);
    assert.ok(call.tokens.input > 0);
    assert.ok(call.model && call.modelVersion);
    assert.ok(call.traceId && call.status === 'success');
    assert.ok(call.latencyMs !== undefined && call.latencyMs > 0 && call.latencyMs < 60_000);
  });

  it('reads null content, an empty result and missing optional fields as absent, not as errors', () => {
    const { call, drift } = normalise({
      meta: { timestamp: '2026-09-23T10:00:00.000Z', sessionId: 's' },
      request: { body: { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{"a":1}' } }] }] } },
      response: { result: '' },
    });
    assert.deepEqual(drift, []);
    assert.equal(call.history[0].content, '');
    assert.equal(call.reply, '');
    assert.equal(call.latencyMs, undefined);
    assert.deepEqual(call.history[0].toolCalls[0].args, { a: 1 });
  });

  it('reports a field of the wrong type by its path, and carries on', () => {
    const { call, drift } = normalise({
      meta: { timestamp: '2026-09-23T10:00:00.000Z', sessionId: 's' },
      request: { body: { messages: 'not a list' as never, tools: [{ function: { name: 't', parameters: 'oops' as never } }] } },
      response: { result: 'hi', finishReason: 'max_turns', tokenUsage: { inputTokens: '12' as never } },
    });
    assert.deepEqual(drift.map((warning) => warning.path).sort(), [
      'request.body.messages', 'request.body.tools[0].function.parameters', 'response.finishReason', 'response.tokenUsage.inputTokens',
    ]);
    assert.equal(call.reply, 'hi');
    assert.equal(call.tools[0].name, 't');
  });

  it('keeps arguments the model wrote that are not JSON, for the checks to flag', () => {
    const { call, drift } = normalise({
      meta: { timestamp: 't', sessionId: 's' },
      response: { toolCalls: [{ id: 'c', function: { name: 'x', arguments: '{broken' } }] },
    });
    assert.deepEqual(drift, []);
    assert.equal(call.toolCalls[0].args, null);
    assert.equal(call.toolCalls[0].argsRaw, '{broken');
  });
});

describe('reconstructing a real session', () => {
  it('puts tool calls and results in the order they happened', () => {
    const session = reconstruct(stored(real('payment-question')));
    assert.deepEqual(session.events.map((event) => `${event.kind}:${event.name}`),
      ['call:verify_borrower', 'result:verify_borrower', 'call:get_loan_summary', 'result:get_loan_summary']);
  });

  it('builds a full record for every call', () => {
    const session = reconstruct(stored(real('payment-question')));
    for (const call of session.toolCalls) {
      assert.ok(call.definition?.parameters, 'definition with schema');
      assert.ok(call.result && call.resultJson, 'result, parsed');
      assert.ok(call.inputId && call.calledAt && call.resultAt);
      assert.ok(call.replyAfter, 'the reply that followed');
      assert.ok(call.llm && call.llm.tokens.input > 0);
    }
  });

  it('keeps text the agent said before calling a tool', () => {
    const call = reconstruct(stored(real('address-change'))).toolCalls.find((record) => record.preamble);
    assert.ok(call, 'a call with text before it');
    assert.equal(call!.name, 'send_confirmation_code');
  });

  it('keeps a knowledge-search result that is text wrapping JSON as text', () => {
    const call = reconstruct(stored(real('first-time-buyer'))).toolCalls[0];
    assert.equal(call.name, 'search_mortgage_kb');
    assert.match(call.result!, /^Found 2 results/);
    assert.equal(call.resultJson, undefined);
  });

  it('gets the same answer whatever order the payloads were stored in', () => {
    const payloads = stored(real('address-change'));
    const reversed = [...payloads].reverse();
    assert.deepEqual(reconstruct(reversed).toolCalls.map((call) => call.name), reconstruct(payloads).toolCalls.map((call) => call.name));
  });
});
