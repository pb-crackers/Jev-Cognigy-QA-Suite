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
import type { Rubric } from '../src/rubrics/model.ts';

let api: StubApi;

/** Requests that scored rubrics — not the follow-up asking which message each answer rests on. */
const scoring = () => api.requests.filter((request) => !Object.keys(request.questions).some((id) => id.startsWith('which_')));
let executeRun: typeof import('../src/scoring/run.ts').executeRun;
let Store: typeof import('../src/store/db.ts').Store;
let DEFAULT_RUBRICS: typeof import('../src/rubrics/defaults.ts').DEFAULT_RUBRICS;

/** A fake OData client: no network, fully controllable transcripts. */
function fakeOdata(turns: { user: string; bot: string }[], sessionIds = ['s1'], channel = 'rest') {
  let base = Date.parse('2026-09-18T10:00:00.000Z');
  const record = (text: string, isUser: boolean): ConversationRecord => ({
    id: String(base), sessionId: 's1', inputId: 'i', projectId: 'p', projectName: 'P',
    inputText: text, inputData: '{}', type: isUser ? 'input' : 'output',
    source: isUser ? 'user' : 'bot', timestamp: new Date((base += 1000)).toISOString(),
    flowName: 'F', channel, endpointName: 'Web', inHandoverRequest: false,
    inHandoverConversation: false, rating: null, ratingComment: null, isMasked: null,
  });

  return {
    async sessions(): Promise<SessionSummary[]> {
      return sessionIds.map((sessionId) => ({
        sessionId, startedAt: '2026-09-18T10:00:00.000Z', lastAt: '2026-09-18T10:10:00.000Z',
        endpointName: 'Web', channel, rating: null, masked: false, records: turns.length * 2,
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

    const before = scoring().length;
    await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false },
      { odata: fakeOdata(SHORT), store, rubrics },
    );

    assert.equal(
      scoring().length - before,
      1,
      `${rubrics.length} rubrics must cost one request, not one each`,
    );
    const sent = scoring().at(-1)!.questions;
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
    const before = scoring().length;
    await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 3, skipScored: false },
      { odata: fakeOdata(SHORT, ['s1', 's2', 's3']), store, rubrics: store.rubrics() },
    );
    // The fake client returns the same session id for all three, so the store
    // folds them; what matters is that requests track sessions, not rubrics.
    assert.ok(scoring().length - before <= 3, 'at most one request per session');
    store.close();
  });

  it('splits a very long transcript and records how many chunks it took', async () => {
    const store = new Store(':memory:');
    store.seedRubrics(DEFAULT_RUBRICS);
    const long = Array.from({ length: 900 }, (_, index) => ({
      user: `Question ${index} about my policy coverage and what it includes in detail`,
      bot: `Answer ${index} explaining the coverage at some length so the transcript grows`,
    }));

    const before = scoring().length;
    const { run } = await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false },
      { odata: fakeOdata(long), store, rubrics: store.rubrics() },
    );

    const requests = scoring().length - before;
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

    const before = scoring().length;
    const { run } = await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false },
      { odata: masked, store, rubrics: store.rubrics() },
    );

    assert.equal(scoring().length, before, 'a masked session is never sent to the model');
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
    const before = scoring().length;

    await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false,
        channels: ['someChannel'] },
      { odata: fakeOdata(SHORT), store, rubrics: store.rubrics() },
    );

    assert.equal(scoring().length - before, 1);
    const state = scoring().at(-1)!.state as Record<string, unknown>;

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

  it('asks a voice-scoped rubric of a call and not of a chat, and only notes the call', async () => {
    // The whole feature in one assertion pair: a rubric scoped to voice is
    // absent from the questions sent for a text conversation, and the modality
    // note rides in the instructions rather than in the state.
    const spelling: Rubric = {
      id: 'spelling', name: 'Confirmed spelling', type: 'boolean', combine: 'last',
      weight: 1, enabled: true,
      question: 'Did the agent confirm the spelling?',
      appliesTo: 'voice',
      notes: { voice: 'The words come from speech recognition.' },
    };
    const general: Rubric = {
      id: 'helped', name: 'Helped', type: 'boolean', combine: 'last',
      weight: 1, enabled: true, question: 'Was the customer helped?',
    };
    const rubrics = [general, spelling];

    const ask = async (channel: string) => {
      const store = new Store(':memory:');
      await executeRun(
        { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false },
        { odata: fakeOdata(SHORT, ['s1'], channel), store, rubrics },
      );
      store.close();
      return scoring().at(-1)!;
    };

    const voice = await ask('voiceGateway2');
    assert.deepEqual(Object.keys(voice.questions).sort(), ['r_helped', 'r_spelling']);
    const scoped = voice.questions.r_spelling as { instructions: { question: string; note?: string } };
    assert.equal(scoped.instructions.question, 'Did the agent confirm the spelling?');
    assert.equal(scoped.instructions.note, 'The words come from speech recognition.');
    assert.ok(
      !JSON.stringify(voice.state).includes('speech recognition'),
      'the note belongs to the question, never to the state',
    );

    const text = await ask('rest');
    assert.deepEqual(Object.keys(text.questions), ['r_helped'], 'the voice rubric is not asked');

    // The Interaction Panel is text like any other typed channel: a rubric must
    // not be able to tell that a session was a developer testing the flow.
    const panel = await ask('adminconsole');
    assert.deepEqual(Object.keys(panel.questions), Object.keys(text.questions));

    // A channel nobody has mapped is asked everything: a score not taken cannot
    // be recovered, whereas a weak answer can be discounted.
    const unmapped = await ask('someNewGateway');
    assert.deepEqual(Object.keys(unmapped.questions).sort(), ['r_helped', 'r_spelling']);
    const unscoped = unmapped.questions.r_spelling as { instructions: { note?: string } };
    assert.equal(unscoped.instructions.note, undefined, 'no modality, so no modality note');
  });

  it('asks an agent run only the rubrics a session is missing', async () => {
    const store = new Store(':memory:');
    const rubrics: Rubric[] = [
      { id: 'a', name: 'A', question: 'A?', type: 'boolean', combine: 'last', weight: 1, enabled: true },
      { id: 'b', name: 'B', question: 'B?', type: 'boolean', combine: 'last', weight: 1, enabled: true },
    ];
    const base = { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: true };

    // An ad-hoc run answers rubric a only.
    await executeRun({ ...base, rubricIds: ['a'] }, { odata: fakeOdata(SHORT), store, rubrics });
    // The agent run wants a and b: only b is missing, so only b is asked.
    const before = scoring().length;
    const outcome = await executeRun(
      { ...base, rubricIds: ['a', 'b'], skipMode: 'rubric', agentId: 'summit' },
      { odata: fakeOdata(SHORT), store, rubrics },
    );
    assert.equal(scoring().length - before, 1);
    assert.deepEqual(Object.keys(scoring().at(-1)!.questions), ['r_b']);
    assert.equal(outcome.scored.length, 1);

    // Asked again, nothing is missing and nothing is sent.
    const again = scoring().length;
    await executeRun({ ...base, rubricIds: ['a', 'b'], skipMode: 'rubric' }, { odata: fakeOdata(SHORT), store, rubrics });
    assert.equal(scoring().length, again);
    store.close();
  });

  it('records a session under the agent even when an ad-hoc run already answered everything', async () => {
    const store = new Store(':memory:');
    const rubrics: Rubric[] = [
      { id: 'a', name: 'A', question: 'A?', type: 'boolean', combine: 'last', weight: 1, enabled: true },
    ];
    const base = { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: true };
    await executeRun({ ...base, rubricIds: ['a'] }, { odata: fakeOdata(SHORT), store, rubrics });
    const before = scoring().length;
    await executeRun({ ...base, rubricIds: ['a'], skipMode: 'rubric', agentId: 'summit' }, { odata: fakeOdata(SHORT), store, rubrics });
    assert.equal(scoring().length, before, 'nothing new to ask, so nothing sent');
    assert.equal(store.agentSessions('summit').length, 1, 'but the agent now holds the session, so health and alerts see it');
    const again = await executeRun({ ...base, rubricIds: ['a'], skipMode: 'rubric', agentId: 'summit' }, { odata: fakeOdata(SHORT), store, rubrics });
    assert.equal(again.scored.length, 0, 'and it is not recorded twice');
    store.close();
  });

  it('re-scores a session in full once it has grown since it was scored', async () => {
    const store = new Store(':memory:');
    const rubrics: Rubric[] = [
      { id: 'a', name: 'A', question: 'A?', type: 'boolean', combine: 'last', weight: 1, enabled: true },
    ];
    const base = { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: true, skipMode: 'rubric' as const };
    await executeRun(base, { odata: fakeOdata(SHORT), store, rubrics });

    const grown = fakeOdata(SHORT);
    const original = grown.sessions.bind(grown);
    grown.sessions = async (...args: Parameters<typeof original>) =>
      (await original(...args)).map((session) => ({ ...session, lastAt: '2026-09-19T09:00:00.000Z' }));
    const before = scoring().length;
    await executeRun(base, { odata: grown, store, rubrics });
    assert.equal(scoring().length - before, 1, 'a grown session is asked again');
    store.close();
  });

  it('defers a session still in progress instead of scoring it half-finished', async () => {
    const store = new Store(':memory:');
    const before = scoring().length;
    const outcome = await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false,
        settledBefore: '2026-09-18T10:00:00.000Z' },
      { odata: fakeOdata(SHORT), store, rubrics: DEFAULT_RUBRICS },
    );
    assert.equal(scoring().length, before, 'nothing sent for an unsettled session');
    assert.equal(outcome.deferred.length, 1);
    assert.equal(outcome.scored.length, 0);
    store.close();
  });

  it('records the agent on the run and the session\'s last record time', async () => {
    const store = new Store(':memory:');
    const { run } = await executeRun(
      { projectId: 'p', projectName: 'P', from: 'a', to: 'b', limit: 1, skipScored: false, agentId: 'summit', label: 'Summit' },
      { odata: fakeOdata(SHORT), store, rubrics: DEFAULT_RUBRICS },
    );
    assert.equal(store.runs()[0].agentId, 'summit');
    assert.equal(store.runs()[0].endpointLabel, 'Summit');
    assert.equal(store.sessionsForRun(run.id)[0].lastAt, '2026-09-18T10:10:00.000Z');
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
