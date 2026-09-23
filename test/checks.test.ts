/**
 * Stage 0: checks decided exactly from the data, with no model.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { validateArgs } from '../src/checks/schema.ts';
import { checkSession, checkToolCalls, toolFailure } from '../src/checks/exact.ts';
import { placeToolCalls } from '../src/traces/place.ts';
import { reconstruct, type ToolCallRecord } from '../src/traces/reconstruct.ts';
import { assemble } from '../src/cognigy/transcript.ts';
import type { StoredTrace, TracePayload } from '../src/traces/model.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/real/${name}`, import.meta.url), 'utf8'));
const stored = (payloads: TracePayload[]): StoredTrace[] => payloads.map((payload, index) => ({
  id: index + 1, agentId: 'a', sessionId: payload.meta.sessionId, inputId: payload.meta.inputId ?? null,
  eventAt: payload.meta.timestamp, receivedAt: payload.meta.timestamp, payload,
}));

const SCHEMA = {
  type: 'object',
  properties: {
    loan_last4: { type: 'string', pattern: '^\\d{4}$' },
    field: { type: 'string', enum: ['mailing_address', 'phone'] },
    months: { type: ['number', 'null'], minimum: 1, maximum: 12 },
    good_through: { type: 'string', format: 'date' },
  },
  required: ['loan_last4', 'field'],
  additionalProperties: false,
};

describe('arguments against the schema', () => {
  it('passes valid arguments, including a nullable union', () => {
    assert.deepEqual(validateArgs({ loan_last4: '2286', field: 'phone', months: null }, SCHEMA), { issues: [], unchecked: [] });
  });

  it('names each problem: missing, wrong type, not in the enum, extra, out of range, bad format, pattern', () => {
    const { issues } = validateArgs({ field: 'fax', months: 30, good_through: '10/01/2026', extra: 1, loan_last4: '22' }, SCHEMA);
    const text = issues.map((issue) => issue.message).join(' | ');
    assert.match(text, /fax.*not one of/);
    assert.match(text, /months is above 12/);
    assert.match(text, /good_through isn't a valid date/);
    assert.match(text, /extra isn't a parameter/);
    assert.match(text, /doesn't match the pattern/);
    assert.equal(validateArgs({}, SCHEMA).issues.filter((issue) => /required/.test(issue.message)).length, 2);
    assert.match(validateArgs({ loan_last4: 2286, field: 'phone' }, SCHEMA).issues[0].message, /should be string, got integer/);
  });

  it('reports keywords it does not check instead of passing them', () => {
    assert.deepEqual(validateArgs({ a: 1 }, { type: 'object', minProperties: 2, properties: { a: { type: 'integer', multipleOf: 2 } } }).unchecked.sort(), ['minProperties', 'multipleOf']);
  });
});

describe('tool call checks', () => {
  const record = (over: Partial<ToolCallRecord>): ToolCallRecord => ({ seq: 1, callId: 'c', name: 'update', args: { loan_last4: '2286', field: 'phone' }, argsRaw: '', result: '{"updated":true}', resultJson: { updated: true }, checks: [], definition: { name: 'update', description: '', parameters: SCHEMA }, ...over });
  const outcome = (checked: ToolCallRecord, id: string) => checked.checks.find((check) => check.id === id)?.outcome;

  it('catches the rejection a live tool returned, with its reason', () => {
    const session = reconstruct(stored(fixture('frustrated.traces.json')));
    checkToolCalls(session.toolCalls, session.tools);
    const rejected = session.toolCalls[0].checks.find((check) => check.id === 'tool_error')!;
    assert.equal(rejected.outcome, 'fail');
    assert.match(rejected.detail!, /status incomplete: .+/);
  });

  it('passes every check on a clean real session', () => {
    const session = reconstruct(stored(fixture('payment-question.traces.json')));
    checkToolCalls(session.toolCalls, session.tools);
    assert.ok(session.toolCalls.every((call) => call.checks.every((check) => check.outcome === 'pass')));
  });

  it('flags a repeat of the same call in the same turn, whatever the key order', () => {
    const calls = [record({ seq: 1, inputId: 'in-1', args: { field: 'phone', loan_last4: '2286' } }), record({ seq: 2, inputId: 'in-1' }), record({ seq: 3, inputId: 'in-2' })];
    checkToolCalls(calls, []);
    assert.equal(outcome(calls[0], 'repeat'), 'pass');
    assert.equal(calls[1].checks.find((check) => check.id === 'repeat')!.detail, 'the same call as #1, in the same turn');
    assert.equal(outcome(calls[2], 'repeat'), 'pass', 'asking again in a later turn can be right');
  });

  it('flags unreadable arguments, an unknown tool and a missing result — and says what it could not check', () => {
    const bad = record({ args: null, argsRaw: '{oops', name: 'nope', definition: undefined, result: undefined, resultJson: undefined, calledAt: '2026-09-23T10:00:00.000Z' });
    checkToolCalls([bad], [{ name: 'update', description: '' }], '2026-09-23T10:00:05.000Z');
    assert.equal(outcome(bad, 'args_parse'), 'fail');
    assert.equal(outcome(bad, 'known_tool'), 'fail');
    assert.equal(outcome(bad, 'schema'), 'unchecked');
    assert.equal(outcome(bad, 'has_result'), 'fail', 'a later call was logged without it');
    assert.equal(outcome(bad, 'tool_error'), 'unchecked');
  });

  it("doesn't fault a call at the very end of a conversation for having no result", () => {
    const last = record({ result: undefined, resultJson: undefined, calledAt: '2026-09-23T10:00:05.000Z' });
    checkToolCalls([last], [], '2026-09-23T10:00:05.000Z');
    assert.equal(outcome(last, 'has_result'), 'unchecked');
  });

  it('reads the ways a tool says no', () => {
    assert.match(toolFailure({ resultJson: { error: 'Loan not found' } })!, /Loan not found/);
    assert.match(toolFailure({ resultJson: { ok: false, message: 'Try later' } })!, /Try later/);
    assert.match(toolFailure({ resultJson: { status: 'REJECTED', reason: 'bad phone' } })!, /status REJECTED: bad phone/);
    assert.ok(toolFailure({ result: 'Error: timeout calling backend' }));
    assert.equal(toolFailure({ resultJson: { status: 'submitted', error: null } }), undefined);
    assert.equal(toolFailure({ result: 'Found 2 results' }), undefined);
  });
});

describe('session checks and placement against the real transcript', () => {
  const session = reconstruct(stored(fixture('payment-question.traces.json')));
  const transcript = assemble('demo-payment-question-mue76yw1-1', fixture('payment-question.conversation.json'));

  it('joins the trace to the transcript by input, with no gaps', () => {
    const checks = checkSession(transcript.turns, session);
    assert.deepEqual(checks.transcriptGaps, []);
    assert.ok(checks.latency.turns > 0 && checks.latency.medianMs! > 0);
  });

  it('places each input\'s calls just before the agent\'s reply to it', () => {
    const placed = placeToolCalls(transcript.turns, session.toolCalls);
    const kinds = placed.map((item) => item.kind === 'calls' ? 'calls' : item.turn.role);
    const first = kinds.indexOf('calls');
    assert.equal(kinds[first - 1], 'user');
    assert.equal(kinds[first + 1], 'agent');
    assert.equal(placed.filter((item) => item.kind === 'calls').flatMap((item) => item.kind === 'calls' ? item.calls : []).length, session.toolCalls.length);
  });

  it('reports a transcript missing a turn the trace knows about', () => {
    const withoutFirst = transcript.turns.filter((turn) => turn.inputId !== session.toolCalls[0].inputId);
    assert.deepEqual(checkSession(withoutFirst, session).transcriptGaps, [session.toolCalls[0].inputId]);
  });
});
