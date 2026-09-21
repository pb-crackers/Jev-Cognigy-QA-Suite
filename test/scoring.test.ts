/**
 * The scoring run against a local stub of the TypeSafe API.
 *
 * This exercises the real SDK, the real request shape and the real answer
 * parsing while spending nothing. What it is really here to prove is the
 * efficiency claim the whole tool rests on: however many rubrics are in the
 * library, a transcript that fits costs exactly one request.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { startStubApi, type StubApi } from './helpers/stub-api.ts';
import type { ConversationRecord, SessionSummary } from '../src/cognigy/odata.ts';

let api: StubApi;
let executeRun: typeof import('../src/scoring/run.ts').executeRun;
let Store: typeof import('../src/store/db.ts').Store;
let DEFAULT_RUBRICS: typeof import('../src/rubrics/defaults.ts').DEFAULT_RUBRICS;

/** A fake OData client: no network, fully controllable transcripts. */
function fakeOdata(turns: { user: string; bot: string }[], sessionIds = ['s1']) {
  let base = Date.parse('2026-09-18T10:00:00.000Z');
  const record = (text: string, isUser: boolean): ConversationRecord => ({
    id: String(base), sessionId: 's1', inputId: 'i', projectId: 'p', projectName: 'P',
    inputText: text, inputData: '{}', type: isUser ? 'input' : 'output',
    source: isUser ? 'user' : 'bot', timestamp: new Date((base += 1000)).toISOString(),
    flowName: 'F', channel: 'rest', endpointName: 'Web', inHandoverRequest: false,
    inHandoverConversation: false, rating: null, ratingComment: null, isMasked: null,
  });

  return {
    async sessions(): Promise<SessionSummary[]> {
      return sessionIds.map((sessionId) => ({
        sessionId, startedAt: '2026-09-18T10:00:00.000Z', lastAt: '2026-09-18T10:10:00.000Z',
        endpointName: 'Web', channel: 'rest', rating: null, masked: false, records: turns.length * 2,
      }));
    },
    async conversation(): Promise<ConversationRecord[]> {
      return turns.flatMap((turn) => [record(turn.user, true), record(turn.bot, false)]);
    },
  } as never;
}

before(async () => {
  api = await startStubApi();
  process.env.TYPESAFE_API_KEY = 'test-key-not-real';
  process.env.TYPESAFE_BASE_URL = api.baseURL;
  ({ executeRun } = await import('../src/scoring/run.ts'));
  ({ Store } = await import('../src/store/db.ts'));
  ({ DEFAULT_RUBRICS } = await import('../src/rubrics/defaults.ts'));
});

after(async () => {
  await api.close();
});

const SHORT = [
  { user: 'I need a quote', bot: 'Happy to help with that.' },
  { user: 'For my car', bot: 'What year is it?' },
];

describe('a scoring run', () => {
  it('answers every rubric in a single request', async () => {
    const store = new Store(':memory:');
    store.seedRubrics(DEFAULT_RUBRICS);
    const rubrics = store.rubrics();
    assert.ok(rubrics.length >= 8, 'the starter set is substantial enough for this to mean something');

    const before = api.requests.length;
    await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false },
      { odata: fakeOdata(SHORT), store, rubrics },
    );

    assert.equal(
      api.requests.length - before,
      1,
      `${rubrics.length} rubrics must cost one request, not one each`,
    );
    const sent = api.requests.at(-1)!.questions;
    assert.equal(Object.keys(sent).length, rubrics.length, 'all rubrics rode in that request');
    store.close();
  });

  it('stores a result for every rubric', async () => {
    const store = new Store(':memory:');
    store.seedRubrics(DEFAULT_RUBRICS);
    const { run } = await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false },
      { odata: fakeOdata(SHORT), store, rubrics: store.rubrics() },
    );
    assert.equal(store.resultsForRun(run.id).length, store.rubrics().length);
    store.close();
  });

  it('costs one request per session, not per rubric per session', async () => {
    const store = new Store(':memory:');
    store.seedRubrics(DEFAULT_RUBRICS);
    const before = api.requests.length;
    await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 3, skipScored: false },
      { odata: fakeOdata(SHORT, ['s1', 's2', 's3']), store, rubrics: store.rubrics() },
    );
    // The fake client returns the same session id for all three, so the store
    // folds them; what matters is that requests track sessions, not rubrics.
    assert.ok(api.requests.length - before <= 3, 'at most one request per session');
    store.close();
  });

  it('splits a very long transcript and records how many chunks it took', async () => {
    const store = new Store(':memory:');
    store.seedRubrics(DEFAULT_RUBRICS);
    const long = Array.from({ length: 900 }, (_, index) => ({
      user: `Question ${index} about my policy coverage and what it includes in detail`,
      bot: `Answer ${index} explaining the coverage at some length so the transcript grows`,
    }));

    const before = api.requests.length;
    const { run } = await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false },
      { odata: fakeOdata(long), store, rubrics: store.rubrics() },
    );

    const requests = api.requests.length - before;
    assert.ok(requests > 1, 'a transcript over the budget is split');
    const [session] = store.sessionsForRun(run.id);
    assert.equal(session.chunks, requests, 'the chunk count is recorded honestly');
    store.close();
  });

  it('reports a masked session as unscoreable and spends nothing on it', async () => {
    const store = new Store(':memory:');
    store.seedRubrics(DEFAULT_RUBRICS);
    const masked = {
      async sessions(): Promise<SessionSummary[]> {
        return [{
          sessionId: 'm1', startedAt: 'a', lastAt: 'b', endpointName: 'Web',
          channel: 'rest', rating: null, masked: true, records: 2,
        }];
      },
      async conversation(): Promise<ConversationRecord[]> {
        return [{
          id: '1', sessionId: 'm1', inputId: 'i', projectId: 'p', projectName: 'P',
          inputText: 'redacted', inputData: '{}', type: 'input', source: 'user',
          timestamp: '2026-09-18T10:00:00.000Z', flowName: 'F', channel: 'rest',
          endpointName: 'Web', inHandoverRequest: false, inHandoverConversation: false,
          rating: null, ratingComment: null, isMasked: true,
        }];
      },
    } as never;

    const before = api.requests.length;
    const { run } = await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false },
      { odata: masked, store, rubrics: store.rubrics() },
    );

    assert.equal(api.requests.length, before, 'a masked session is never sent to the model');
    const [session] = store.sessionsForRun(run.id);
    assert.equal(session.unscoreable, 'masked');
    assert.equal(store.resultsForRun(run.id).length, 0);
    store.close();
  });

  it('sends exactly the state it always has, and nothing about the channel', async () => {
    // Jev is not deterministic — three byte-identical requests were measured
    // varying 4 of 9 rubrics, frustration by 0.22 — so re-scoring and diffing
    // answers cannot prove a change was score-neutral. The payload can be
    // proved instead, which is what this asserts: adding channel labelling and
    // filtering must not alter what the model is asked.
    const store = new Store(':memory:');
    store.seedRubrics(DEFAULT_RUBRICS);
    const before = api.requests.length;

    await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false,
        channels: ['someChannel'] },
      { odata: fakeOdata(SHORT), store, rubrics: store.rubrics() },
    );

    assert.equal(api.requests.length - before, 1);
    const state = api.requests.at(-1)!.state as Record<string, unknown>;

    assert.deepEqual(
      Object.keys(state).sort(),
      ['conversation', 'flow'],
      'the state carries the transcript and the flow, and nothing else',
    );
    assert.equal(typeof state.conversation, 'string');
    const serialised = JSON.stringify(state);
    for (const leaked of ['channel', 'Channel', 'Voice', 'Interaction Panel', 'someChannel']) {
      assert.ok(!serialised.includes(leaked), `state must not mention ${leaked}`);
    }
    store.close();
  });

  it('refuses to run with no rubrics enabled', async () => {
    const store = new Store(':memory:');
    await assert.rejects(
      executeRun(
        { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false },
        { odata: fakeOdata(SHORT), store, rubrics: [] },
      ),
      /No rubrics are enabled/,
    );
    store.close();
  });
});
