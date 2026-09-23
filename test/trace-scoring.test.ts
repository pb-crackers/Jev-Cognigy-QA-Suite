/**
 * Scoring with the agent's logged LLM calls in the state, against the local
 * stub of the TypeSafe API. What this proves: the instructions and tool calls
 * reach the grader, a trace-dependent rubric is only asked when it can be
 * answered, and a session without traces is graded exactly as before.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { startStubApi, type StubApi } from './helpers/stub-api.ts';
import type { ConversationRecord, SessionSummary } from '../src/cognigy/odata.ts';
import type { Rubric } from '../src/rubrics/model.ts';
import type { Turn } from '../src/cognigy/transcript.ts';
import type { ToolCallRecord } from '../src/traces/reconstruct.ts';

let api: StubApi;

/** Requests that scored rubrics — not the follow-up asking which message each answer rests on. */
const scoring = () => api.requests.filter((request) => !Object.keys(request.questions).some((id) => id.startsWith('which_')));
let executeRun: typeof import('../src/scoring/run.ts').executeRun;
let Store: typeof import('../src/store/db.ts').Store;
let createAgent: typeof import('../src/agents/service.ts').createAgent;
let importTraces: typeof import('../src/traces/receiver.ts').importTraces;
let withToolLines: typeof import('../src/scoring/state.ts').withToolLines;
let reconstruct: typeof import('../src/traces/reconstruct.ts').reconstruct;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** The fixture session as OData would report it: two inputs, both answered by the AI Agent node. */
function odataFor(sessionId = 'sess-1') {
  let clock = Date.parse('2026-09-23T00:18:00.000Z');
  const record = (text: string, isUser: boolean, inputId: string): ConversationRecord => ({
    id: String(clock), sessionId, inputId, projectId: 'p1', projectName: 'P',
    inputText: text, type: isUser ? 'input' : 'output', source: isUser ? 'user' : 'bot',
    inputData: isUser ? '{}' : JSON.stringify({ metadata: { nodeType: 'aiAgentJob', nodeLabel: 'AI Agent' } }),
    timestamp: new Date((clock += 10_000)).toISOString(), flowName: 'Main', channel: 'rest',
    endpointName: 'REST', inHandoverRequest: false, inHandoverConversation: false,
    rating: null, ratingComment: null, isMasked: null,
  });
  const records = [
    record('hi i want to apply for a loan', true, 'in-1'),
    record("Hi, I'm Sam. May I have your name?", false, 'in-1'),
    record('what would my payment be on a 400k house with 40k down?', true, 'in-2'),
    record('About $2,780 to $3,050 a month. This is an estimate.', false, 'in-2'),
  ];
  return {
    async sessions(): Promise<SessionSummary[]> {
      return [{ sessionId, startedAt: records[0].timestamp, lastAt: records.at(-1)!.timestamp,
        endpointName: 'REST', channel: 'rest', rating: null, masked: false, records: records.length }];
    },
    async conversation() { return records; },
  } as never;
}

const rubrics: Rubric[] = [
  { id: 'helped', name: 'Helped', question: 'Was the customer helped?', type: 'boolean', combine: 'last', weight: 1, enabled: true },
  { id: 'tool_first', name: 'Figures from tools', question: 'Did every payment figure come from a tool call?',
    type: 'boolean', combine: 'last', weight: 1, enabled: true, requiresTrace: true },
];

before(async () => {
  api = await startStubApi();
  process.env.TYPESAFE_API_KEY = 'test-key-not-real';
  process.env.TYPESAFE_BASE_URL = api.baseURL;
  ({ executeRun } = await import('../src/scoring/run.ts'));
  ({ Store } = await import('../src/store/db.ts'));
  ({ createAgent } = await import('../src/agents/service.ts'));
  ({ importTraces } = await import('../src/traces/receiver.ts'));
  ({ withToolLines } = await import('../src/scoring/state.ts'));
  ({ reconstruct } = await import('../src/traces/reconstruct.ts'));
});
after(async () => {
  await api.close();
});

function agentSetup(withTraces: 'all' | 'first-input' | 'none') {
  const store = new Store(':memory:');
  const agent = createAgent({ name: 'Home Loans', projectId: 'p1', endpoints: [{ id: 'e', name: 'REST' }],
    rubrics: { helped: true, tool_first: true } }, store, rubrics);
  const traces = fixture('trace-session.json');
  if (withTraces === 'all') importTraces(store, agent.id, traces);
  if (withTraces === 'first-input') importTraces(store, agent.id, traces.slice(0, 1));
  return { store, agent };
}

const run = (store: InstanceType<typeof Store>, agentId?: string) => executeRun(
  { projectId: 'p1', projectName: 'P', from: 'a', to: 'b', limit: 5, skipScored: false, agentId },
  { odata: odataFor(), store, rubrics },
);

describe('trace-aware state', () => {
  it('gives the grader the instructions and tools, and writes tool calls into the conversation', async () => {
    const { store, agent } = agentSetup('all');
    await run(store, agent.id);
    const request = scoring().at(-1)!;
    const state = request.state as Record<string, unknown>;

    assert.deepEqual(Object.keys(state).sort(), ['conversation', 'flow', 'instructions', 'tools']);
    assert.match(String(state.instructions), /Any payment figure comes from estimate_payment/);
    assert.deepEqual((state.tools as { name: string }[]).map((tool) => tool.name), ['estimate_payment', 'check_eligibility']);

    const conversation = String(state.conversation);
    const call = conversation.indexOf('[tool call estimate_payment');
    const result = conversation.indexOf('[tool result estimate_payment');
    const reply = conversation.indexOf('Agent: About $2,780');
    assert.ok(call > -1 && result > call && reply > result, 'call, then result, then the reply that used it');
    assert.ok(conversation.indexOf('Customer: what would my payment be') < call, 'after the question that prompted it');
    store.close();
  });

  it('asks a trace-dependent rubric only when every LLM turn is logged', async () => {
    const full = agentSetup('all');
    await run(full.store, full.agent.id);
    assert.ok('r_tool_first' in scoring().at(-1)!.questions);
    assert.equal(full.store.sessionsForRun(full.store.runs()[0].id)[0].traceCoverage, 'full');
    full.store.close();

    const partial = agentSetup('first-input');
    await run(partial.store, partial.agent.id);
    assert.ok(!('r_tool_first' in scoring().at(-1)!.questions), 'half-logged: not answerable');
    assert.ok('r_helped' in scoring().at(-1)!.questions);
    assert.equal(partial.store.sessionsForRun(partial.store.runs()[0].id)[0].traceCoverage, 'partial');
    partial.store.close();
  });

  it('grades an agent session with no traces exactly as an untraced session', async () => {
    const { store, agent } = agentSetup('none');
    await run(store, agent.id);
    const state = scoring().at(-1)!.state as Record<string, unknown>;
    assert.deepEqual(Object.keys(state).sort(), ['conversation', 'flow']);
    assert.ok(!String(state.conversation).includes('[tool'));
    store.close();
  });

  it('finds, in one more request, which message each pass/fail answer rests on', async () => {
    const { store, agent } = agentSetup('all');
    const before = api.requests.length;
    await run(store, agent.id);
    const followUps = api.requests.slice(before).filter((request) => Object.keys(request.questions).some((id) => id.startsWith('which_')));
    assert.equal(followUps.length, 1, 'one request for every answer');
    assert.deepEqual(Object.keys(followUps[0].questions).sort(), ['which_helped', 'which_tool_first']);
    const stored = store.locatesForRubric(agent.id, 'helped').get('sess-1');
    assert.ok(stored && stored.key, 'kept, keyed to the answer it was asked about');
    store.close();
  });

  it('keeps the scores when finding the messages fails', async () => {
    const { store, agent } = agentSetup('all');
    api.setOverrides({ which_helped: { fail: true } });
    const { run: saved } = await run(store, agent.id);
    assert.ok(store.resultsForRun(saved.id).length > 0, 'scored all the same');
    assert.equal(store.locatesForRubric(agent.id, 'helped').size, 0, 'the lookup failed, so nothing was stored');
    api.setOverrides({});
    store.close();
  });

  it('stores the conversation as it happened, and the tool calls as checked records beside it', async () => {
    const { store, agent } = agentSetup('all');
    const { run: saved } = await run(store, agent.id);
    const row = store.sessionsForRun(saved.id)[0];
    const turns = JSON.parse(row.transcript) as Turn[];
    assert.equal(turns.filter((turn) => turn.tool).length, 0, 'no tool lines baked into the transcript');
    assert.equal(row.turns, 4);
    const calls = store.toolCallsFor(agent.id, 'sess-1');
    assert.deepEqual(calls.map((call) => call.name), ['estimate_payment']);
    assert.ok(calls[0].checks.length > 0 && calls[0].result);
    const checks = JSON.parse(row.checks!);
    assert.deepEqual(checks.transcriptGaps, []);
    assert.equal(checks.latency.turns, 2);
    store.close();
  });

  it('does not use traces on an ad-hoc run', async () => {
    const { store } = agentSetup('all');
    await run(store);
    assert.deepEqual(Object.keys(scoring().at(-1)!.state as object).sort(), ['conversation', 'flow']);
    store.close();
  });
});

describe('one session failing', () => {
  /** Two sessions; the first can't be read from Cognigy until `broken` is cleared. */
  function twoSessions(state: { broken: boolean }) {
    const ok = odataFor('sess-ok');
    const bad = odataFor('sess-bad');
    const asked: { sessionIds?: readonly string[] }[] = [];
    return {
      asked,
      odata: {
        async sessions(options: { from: string; sessionIds?: readonly string[] }) {
          asked.push(options);
          const all = [...await bad.sessions(), ...await ok.sessions()];
          if (options.sessionIds) return all.filter((session) => options.sessionIds!.includes(session.sessionId));
          // Once the watermark has moved on, the failed session is outside the range.
          return options.from === 'later' ? all.filter((session) => session.sessionId !== 'sess-bad') : all;
        },
        async conversation(_project: string, sessionId: string) {
          if (sessionId === 'sess-bad' && state.broken) throw new Error('Cognigy answered 502');
          return (sessionId === 'sess-bad' ? bad : ok).conversation();
        },
      } as never,
    };
  }

  it('records the failure, scores the rest, and retries it next time', async () => {
    const store = new Store(':memory:');
    const agent = createAgent({ name: 'Home Loans', projectId: 'p1', endpoints: [{ id: 'e', name: 'REST' }],
      rubrics: { helped: true } }, store, rubrics);
    const state = { broken: true };
    const { odata, asked } = twoSessions(state);
    const request = { projectId: 'p1', projectName: 'P', from: 'a', to: 'b', limit: 5, skipScored: true, skipMode: 'rubric' as const, agentId: agent.id };

    const first = await executeRun(request, { odata, store, rubrics });
    assert.deepEqual(first.scored.map((session) => session.sessionId), ['sess-ok']);
    assert.deepEqual(first.failed, [{ sessionId: 'sess-bad', error: 'Cognigy answered 502', attempts: 1 }]);
    assert.deepEqual(store.failedSessions(agent.id), [{ sessionId: 'sess-bad', attempts: 1, error: 'Cognigy answered 502' }]);

    const second = await executeRun({ ...request, retrySessionIds: ['sess-bad'] }, { odata, store, rubrics });
    assert.equal(second.failed[0].attempts, 2, 'counts consecutive failures');

    state.broken = false;
    const third = await executeRun({ ...request, from: 'later', retrySessionIds: ['sess-bad'] }, { odata, store, rubrics });
    assert.ok(third.scored.some((session) => session.sessionId === 'sess-bad'), 'scored once it can be');
    assert.deepEqual(third.found.map((session) => session.sessionId), ['sess-ok'], 'a retry is not counted as discovered');
    assert.deepEqual(store.failedSessions(agent.id), []);
    assert.ok(asked.some((options) => options.sessionIds?.includes('sess-bad')), 'fetched by id, whenever it happened');
    store.close();
  });
});

describe('retrying after a failure', () => {
  it('clears a failure even when an earlier run already answered everything', async () => {
    const store = new Store(':memory:');
    const agent = createAgent({ name: 'Home Loans', projectId: 'p1', endpoints: [{ id: 'e', name: 'REST' }],
      rubrics: { helped: true } }, store, rubrics);
    // An ad-hoc run answers the rubric; the agent's own first pass then fails reading the conversation.
    await executeRun({ projectId: 'p1', projectName: 'P', from: 'a', to: 'b', limit: 5, skipScored: false }, { odata: odataFor(), store, rubrics: [rubrics[0]] });
    const request = { projectId: 'p1', projectName: 'P', from: 'a', to: 'b', limit: 5, skipScored: true, skipMode: 'rubric' as const, agentId: agent.id, rubricIds: ['helped'] };
    const broken = { ...odataFor(), async conversation() { throw new Error('Cognigy answered 502'); } };
    await executeRun(request, { odata: broken as never, store, rubrics });
    assert.equal(store.failedSessions(agent.id).length, 1);

    // Nothing is left to ask, but the retry must still be processed: that's what clears the failure.
    await executeRun({ ...request, retrySessionIds: ['sess-1'] }, { odata: odataFor(), store, rubrics });
    assert.deepEqual(store.failedSessions(agent.id), []);
    store.close();
  });

  it('lets an ad-hoc run try a session again after it failed', async () => {
    const store = new Store(':memory:');
    const request = { projectId: 'p1', projectName: 'P', from: 'a', to: 'b', limit: 5, skipScored: true };
    const broken = { ...odataFor(), async conversation() { throw new Error('Cognigy answered 502'); } };
    const first = await executeRun(request, { odata: broken as never, store, rubrics: [rubrics[0]] });
    assert.equal(first.failed.length, 1);
    const second = await executeRun(request, { odata: odataFor(), store, rubrics: [rubrics[0]] });
    assert.deepEqual(second.scored.map((session) => session.sessionId), ['sess-1']);
    store.close();
  });
});

describe('placing tool lines', () => {
  const turn = (role: Turn['role'], text: string, inputId?: string): Turn => ({ role, text, at: 't', inputId });

  const call = (over: Partial<ToolCallRecord>): ToolCallRecord => ({ seq: 1, callId: 'c1', name: 'lookup', args: {}, argsRaw: '{}', checks: [], ...over });

  it('puts a call with no reply after the last line of its input', () => {
    const trace = { ...reconstruct([]), toolCalls: [call({ inputId: 'in-1' })] };
    const out = withToolLines([turn('user', 'q', 'in-1'), turn('user', 'next', 'in-2')], trace);
    assert.deepEqual(out.map((line) => line.text), ['q', '[tool call lookup {}]', 'next']);
  });

  it('puts calls after text the agent said before calling, and before its reply', () => {
    const trace = { ...reconstruct([]), toolCalls: [call({ inputId: 'in-1', preamble: 'Let me   check that **for you**.', result: '{"ok":true}' })] };
    const out = withToolLines([turn('user', 'q', 'in-1'), turn('agent', 'Let me check that for you.', 'in-1'), turn('agent', 'All done.', 'in-1')], trace);
    assert.deepEqual(out.map((line) => line.text), ['q', 'Let me check that for you.', '[tool call lookup {}]', '[tool result lookup: {"ok":true}]', 'All done.']);
  });

  it('puts each round after the text that introduced it when an input has two', () => {
    const trace = { ...reconstruct([]), toolCalls: [
      call({ seq: 1, callId: 'a', name: 'first', inputId: 'in-1', round: 0, preamble: 'Let me look that up.' }),
      call({ seq: 2, callId: 'b', name: 'second', inputId: 'in-1', round: 1, preamble: 'One more check.' }),
    ] };
    const out = withToolLines([turn('user', 'q', 'in-1'), turn('agent', 'Let me look that up.', 'in-1'), turn('agent', 'One more check.', 'in-1'), turn('agent', 'Done.', 'in-1')], trace);
    assert.deepEqual(out.map((line) => line.text), ['q', 'Let me look that up.', '[tool call first {}]', 'One more check.', '[tool call second {}]', 'Done.']);
  });

  it('recognises text said before a call in any script', () => {
    const trace = { ...reconstruct([]), toolCalls: [call({ inputId: 'in-1', preamble: 'Позвольте проверить.' })] };
    const out = withToolLines([turn('user', 'q', 'in-1'), turn('agent', 'Позвольте проверить.', 'in-1'), turn('agent', 'Готово.', 'in-1')], trace);
    assert.deepEqual(out.map((line) => line.text), ['q', 'Позвольте проверить.', '[tool call lookup {}]', 'Готово.']);
  });

  it('trims a long tool result with a visible marker', () => {
    const trace = { ...reconstruct([]), toolCalls: [call({ result: 'x'.repeat(5000) })] };
    const [, line] = withToolLines([], trace);
    assert.ok(line.text.length < 2100);
    assert.match(line.text, /trimmed 3000 characters/);
  });
});
