/**
 * Pointing at the agent message a verdict rests on: one choice question, asked
 * of the stub API, and cached per verdict.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { startStubApi, type StubApi } from './helpers/stub-api.ts';
import type { Rubric } from '../src/rubrics/model.ts';
import type { Turn } from '../src/cognigy/transcript.ts';

let api: StubApi;
let locate: typeof import('../src/scoring/locate.ts').locate;
let verdictText: typeof import('../src/scoring/locate.ts').verdictText;
let locateSession: typeof import('../src/scoring/locate.ts').locateSession;
let createAgent: typeof import('../src/agents/service.ts').createAgent;
let Ledger: typeof import('../src/metering.ts').Ledger;
let Store: typeof import('../src/store/db.ts').Store;

const rate: Rubric = { id: 'quoted_rate', name: 'Quoted a specific rate', question: 'Did the agent state a specific interest rate?',
  type: 'boolean', combine: 'any', weight: 2, enabled: true, invert: true };
const turn = (role: Turn['role'], text: string): Turn => ({ role, text, at: 't' });
const turns: Turn[] = [
  turn('user', 'What are your rates?'),
  turn('agent', "I can't quote a rate, but I can explain what affects it."),
  turn('user', 'Just tell me.'),
  turn('system', '[tool call check_market_reference_rate {}]'),
  turn('agent', 'A 30-year fixed would be roughly 6.1% for a strong borrower.'),
];

before(async () => {
  api = await startStubApi();
  process.env.TYPESAFE_API_KEY = 'test-key-not-real';
  process.env.TYPESAFE_BASE_URL = api.baseURL;
  ({ locate, verdictText, locateSession } = await import('../src/scoring/locate.ts'));
  ({ createAgent } = await import('../src/agents/service.ts'));
  ({ Ledger } = await import('../src/metering.ts'));
  ({ Store } = await import('../src/store/db.ts'));
});
after(async () => {
  await api.close();
});

describe('which message a verdict rests on', () => {
  it('asks one choice between the agent messages and "none", stating the verdict', async () => {
    api.setOverrides({ which_message: { type: 'choice', choice: 'message_2', confidence: 0.94 } });
    const found = await locate(rate, '0.86', turns, {}, new Ledger(), 's1');
    const request = api.requests.at(-1)!;
    assert.deepEqual(Object.keys(request.questions), ['which_message']);
    assert.deepEqual(Object.keys(request.questions.which_message.criteria as object), ['message_1', 'message_2', 'none']);
    assert.match(JSON.stringify(request.questions), /was yes\. Which agent message/);
    assert.match(String((request.state as { conversation: string }).conversation), /Agent message 2: A 30-year fixed/);
    assert.deepEqual(found, { raw: '0.86', turnIndex: 4, message: 2, confidence: 0.94 });
  });

  it('says so when no single message decides it', async () => {
    api.setOverrides({ which_message: { type: 'choice', choice: 'none', confidence: 0.8 } });
    const found = await locate(rate, '0.2', turns, {}, new Ledger(), 's1');
    assert.equal(found.turnIndex, null);
    assert.equal(found.reason, 'no single message decides this one');
  });

  it('marks nothing when Jev reports no confidence at all', async () => {
    api.setOverrides({ which_message: { type: 'choice', choice: 'message_2' } });
    const found = await locate(rate, '0.86', turns, {}, new Ledger(), 's1');
    assert.equal(found.turnIndex, null);
    assert.equal(found.reason, 'Jev isn’t sure which message');
  });

  it('marks nothing when Jev is not sure which message', async () => {
    api.setOverrides({ which_message: { type: 'choice', choice: 'message_1', confidence: 0.3 } });
    const found = await locate(rate, '0.86', turns, {}, new Ledger(), 's1');
    assert.equal(found.turnIndex, null);
    assert.equal(found.message, 1);
    assert.equal(found.reason, 'Jev isn’t sure which message');
  });

  it("doesn't ask when the agent said nothing", async () => {
    const before = api.requests.length;
    const found = await locate(rate, '0.1', [turn('user', 'hello?')], {}, new Ledger(), 's1');
    assert.equal(api.requests.length, before);
    assert.equal(found.reason, 'the agent said nothing');
  });

  it('states the verdict in words for each kind of rubric', () => {
    assert.equal(verdictText(rate, '0.86'), 'yes');
    assert.equal(verdictText(rate, '0.2'), 'no');
    assert.equal(verdictText({ ...rate, type: 'score', levels: ['calm', 'irritated', 'angry'] }, '2'), 'angry');
    assert.equal(verdictText({ ...rate, type: 'score', levels: ['calm', 'irritated', 'angry'] }, '1.5'), 'about angry', 'an average of chunks, named by its nearest level');
    assert.equal(verdictText({ ...rate, type: 'choice' }, 'too_soon'), 'too_soon');
  });

  it('asks Jev once per answer: stored after the first, shared by opens at the same moment', async () => {
    api.setOverrides({ which_message: { type: 'choice', choice: 'message_2', confidence: 0.94 } });
    const store = new Store(':memory:');
    const agent = createAgent({ name: 'Avery', projectId: 'p', endpoints: [{ id: 'e', name: 'E' }] }, store, []);
    store.saveRun({ id: 'r', startedAt: 't', projectId: 'p', projectName: 'P', endpointLabel: 'E', fromTs: 'a', toTs: 'b', sessions: 1, costUsd: 0, ms: 0, agentId: agent.id });
    store.saveSession({ runId: 'r', sessionId: 's1', startedAt: 't', endpointLabel: 'E', channel: 'rest', channelLabel: 'REST API', flowName: null,
      turns: 5, chunks: 1, rating: null, ratingComment: null, unscoreable: null, transcript: JSON.stringify(turns), costUsd: 0, ms: 0 },
    [{ runId: 'r', sessionId: 's1', rubricId: 'quoted_rate', raw: '0.86', confidence: null, chunks: 1, decidedBy: null }]);

    const before = api.requests.length;
    const [first, second] = await Promise.all([locateSession(store, agent, rate, 's1'), locateSession(store, agent, rate, 's1')]);
    assert.equal(api.requests.length, before + 1, 'two opens at once, one question');
    assert.ok('located' in first && 'located' in second && first.located.message === 2 && second.located.message === 2);
    const again = await locateSession(store, agent, rate, 's1');
    assert.equal(api.requests.length, before + 1, 'served from what was stored');
    assert.ok('located' in again && again.located.cached);

    const edited = await locateSession(store, agent, { ...rate, question: 'Did the agent give any rate figure?' }, 's1');
    assert.equal(api.requests.length, before + 2, 'an edited question asks again');
    assert.ok('located' in edited && !edited.located.cached);
    assert.equal((await locateSession(store, agent, { ...rate, id: 'helped' }, 's1')).status, 409, 'no answer yet');
    store.close();
  });
});
