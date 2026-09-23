/**
 * Rubric validity and rubric-set coverage, against the stub Jev API. The
 * formula, the warnings and the constraint extraction are pure and tested
 * directly; the model calls are tested for what they send.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { startStubApi, type StubApi } from './helpers/stub-api.ts';
import type { Rubric } from '../src/rubrics/model.ts';

let api: StubApi;
let V: typeof import('../src/validity/validity.ts');
let C: typeof import('../src/validity/coverage.ts');
let Store: typeof import('../src/store/db.ts').Store;
let createAgent: typeof import('../src/agents/service.ts').createAgent;
let importTraces: typeof import('../src/traces/receiver.ts').importTraces;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const rubric = (over: Partial<Rubric>): Rubric => ({
  id: 'r', name: 'R', question: 'Q?', type: 'boolean', combine: 'last', weight: 1, enabled: true, ...over,
});

function storeWithAnswers(rubricId: string, raws: string[], confidence: number | null = null) {
  const store = new Store(':memory:');
  raws.forEach((raw, i) => {
    const runId = `run${i}`;
    store.saveRun({ id: runId, startedAt: `2026-09-2${i % 3}T00:00:${String(i).padStart(2, '0')}Z`, projectId: 'p', projectName: 'P',
      endpointLabel: 'E', fromTs: 'a', toTs: 'b', sessions: 1, costUsd: 0, ms: 1 });
    store.saveSession({ runId, sessionId: `s${i}`, startedAt: '2026-09-22T00:00:00Z', endpointLabel: 'E', channel: 'rest',
      channelLabel: 'REST API', flowName: 'F', turns: 2, chunks: 1, rating: null, ratingComment: null, unscoreable: null,
      transcript: JSON.stringify([{ role: 'user', text: 'hi', at: 't' }, { role: 'agent', text: 'hello', at: 't' }]),
      costUsd: 0, ms: 1 }, [{ runId, sessionId: `s${i}`, rubricId, raw, confidence, chunks: 1, decidedBy: null }]);
  });
  return store;
}

before(async () => {
  api = await startStubApi();
  process.env.TYPESAFE_API_KEY = 'test-key-not-real';
  process.env.TYPESAFE_BASE_URL = api.baseURL;
  V = await import('../src/validity/validity.ts');
  C = await import('../src/validity/coverage.ts');
  ({ Store } = await import('../src/store/db.ts'));
  ({ createAgent } = await import('../src/agents/service.ts'));
  ({ importTraces } = await import('../src/traces/receiver.ts'));
});
after(async () => {
  await api.close();
});

describe('the validity formula', () => {
  const lint = { observable: 1, single: 1, clear: 0.8, separates: 0.6 };
  const quiet = { answers: 0, positiveRate: null, meanConfidence: null, lowConfidenceShare: 0 };

  it('is the lint mean when nothing else is known', () => {
    assert.equal(V.validityOf(rubric({}), lint, quiet, null).validity, 0.85);
  });

  it('counts an unchecked rubric at half weight', () => {
    assert.equal(V.validityOf(rubric({}), null, quiet, null).validity, V.UNCHECKED_VALIDITY);
  });

  it('is cut by instability and by low confidence', () => {
    const unstable = V.validityOf(rubric({}), lint, quiet, { comparisons: 5, flips: 2, meanDelta: 0.3 });
    assert.equal(Number(unstable.validity.toFixed(3)), 0.51);
    assert.match(unstable.warnings.join(), /changed on 2 of 5 identical re-asks/);
    const unsure = V.validityOf(rubric({}), lint, { ...quiet, lowConfidenceShare: 1 }, null);
    assert.equal(unsure.validity, 0.425);
  });

  it('includes intent fit when the author stated one, and says when it fails', () => {
    const result = V.validityOf(rubric({ intent: 'catch unauthorised discounts' }), { ...lint, intent: 0.1 }, quiet, null);
    assert.equal(Number(result.validity.toFixed(2)), 0.7);
    assert.match(result.warnings.join(), /may not catch what its intent says/);
  });

  it('warns about a quality rubric that never varies, but not an alert that rarely fires', () => {
    const flat = { answers: 40, positiveRate: 0, meanConfidence: null, lowConfidenceShare: 0 };
    assert.match(V.validityOf(rubric({ kind: 'quality' }), lint, flat, null).warnings.join(), /same answer almost every time/);
    assert.deepEqual(V.validityOf(rubric({ kind: 'alert' }), lint, flat, null).warnings, []);
  });
});

describe('verdict flips', () => {
  it('reads a flip the way each rubric type means it', () => {
    assert.equal(V.flipped(rubric({ type: 'boolean' }), 0.7, 0.3), true);
    assert.equal(V.flipped(rubric({ type: 'boolean' }), 0.7, 0.9), false);
    assert.equal(V.flipped(rubric({ type: 'score', levels: ['a', 'b', 'c'] }), 1, 1.4), false);
    assert.equal(V.flipped(rubric({ type: 'score', levels: ['a', 'b', 'c'] }), 1, 1.6), true);
    assert.equal(V.flipped(rubric({ type: 'choice' }), 'yes', 'no'), true);
  });
});

describe('behaviour', () => {
  it('summarises stored answers at no cost', () => {
    const store = storeWithAnswers('r', ['0.9', '0.1', '0.8', '0.2'], 0.4);
    const behaviour = V.behaviourOf(rubric({}), store);
    assert.equal(behaviour.answers, 4);
    assert.equal(behaviour.positiveRate, 0.5);
    assert.equal(behaviour.lowConfidenceShare, 1);
    store.close();
  });
});

describe('checking validity', () => {
  it('asks Jev about each rubric with that rubric alone as the state', async () => {
    const store = new Store(':memory:');
    const before = api.requests.length;
    const target = rubric({ id: 'discount', question: 'Did the agent offer a discount?', intent: 'catch unauthorised discounts' });
    const { reports } = await V.checkValidity(store, [target, rubric({ id: 'off', enabled: false })]);
    assert.equal(api.requests.length - before, 1, 'one request, and none for a disabled rubric');
    const request = api.requests.at(-1)!;
    assert.deepEqual(Object.keys(request.questions).sort(), ['clear', 'intent', 'observable', 'separates', 'single']);
    assert.equal((request.state as { rubric: { question: string } }).rubric.question, 'Did the agent offer a discount?');
    assert.equal(reports[0].lintScore, 0.9, 'the stub says 0.9 to every yes/no question');
    assert.ok(store.validityReports().has('discount'));
    store.close();
  });

  it('measures stability by re-asking stored sessions and comparing verdicts', async () => {
    const store = storeWithAnswers('r', ['0.9', '0.1', '0.9']);
    api.setOverrides({ r_r: { type: 'noul', noul: 0.8 } });
    const stability = await V.measureStability([rubric({})], store, new (await import('../src/metering.ts')).Ledger(), 3);
    api.setOverrides({});
    assert.deepEqual(stability.get('r'), { comparisons: 3, flips: 1, meanDelta: (0.1 + 0.7 + 0.1) / 3 });
    store.close();
  });

  it('keeps a stability measured earlier when only lint is re-run', async () => {
    const store = new Store(':memory:');
    store.saveValidity('r', { stability: { comparisons: 4, flips: 1, meanDelta: 0.2 } }, '2026-09-20T00:00:00Z');
    const { reports } = await V.checkValidity(store, [rubric({})]);
    assert.deepEqual(reports[0].stability, { comparisons: 4, flips: 1, meanDelta: 0.2 });
    store.close();
  });
});

describe('coverage', () => {
  const prompt = fixture('trace-greeting.json').request.body.messages[0].content as string;

  it('keeps the instructions and drops headings and boilerplate', () => {
    const list = C.constraints(prompt);
    assert.ok(list.includes('Any payment figure comes from estimate_payment.'));
    assert.ok(list.includes('Ask at most two questions per turn.'));
    assert.ok(list.some((text) => text.startsWith('Any statement about which programs')));
    assert.ok(!list.some((text) => /To Avoid Jailbreaks/.test(text)), 'a heading is not an instruction');
    assert.ok(!list.some((text) => /Use the user's language/.test(text)), 'platform boilerplate is not the author\'s rule');
  });

  it('asks one choice per instruction, over the agent\'s rubrics plus none, and counts the gaps', async () => {
    const store = new Store(':memory:');
    const rubrics = [rubric({ id: 'tool_first', question: 'Did figures come from tools?' }), rubric({ id: 'other', origin: 'custom' })];
    const agent = createAgent({ name: 'Home Loans', projectId: 'p', endpoints: [{ id: 'e', name: 'E' }], rubrics: { tool_first: true } }, store, rubrics);
    importTraces(store, agent.id, fixture('trace-greeting.json'));

    const count = C.constraints(prompt).length;
    // The stub picks the first option; make every other instruction a gap.
    const overrides: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 2) overrides[`c${i}`] = { type: 'choice', choice: 'none', confidence: 0.9, probabilities: {} };
    api.setOverrides(overrides);
    const report = await C.checkCoverage(agent, rubrics, store);
    api.setOverrides({});

    const question = api.requests.at(-1)!.questions.c1 as { criteria: Record<string, string> };
    assert.deepEqual(Object.keys(question.criteria), ['tool_first', 'none'], 'only the agent\'s own rubrics, plus none');
    assert.equal(report.gaps, Math.ceil(count / 2));
    assert.equal(report.covered, count - report.gaps);
    assert.ok(store.coverageFor(agent.id));
    store.close();
  });

  it('leaves a general rubric out of the choice, and names it as watching the gaps', async () => {
    const store = new Store(':memory:');
    const rubrics = [
      rubric({ id: 'specific', question: 'Did figures come from tools?' }),
      rubric({ id: 'catch_all', question: 'Did it break any of its instructions?', general: true }),
    ];
    const agent = createAgent({ name: 'General', projectId: 'p', endpoints: [{ id: 'e', name: 'E' }] }, store, rubrics);
    importTraces(store, agent.id, fixture('trace-greeting.json'));
    const report = await C.checkCoverage(agent, rubrics, store);
    const question = api.requests.at(-1)!.questions.c0 as { criteria: Record<string, string> };
    assert.deepEqual(Object.keys(question.criteria), ['specific', 'none']);
    assert.deepEqual(report.general, ['catch_all']);
    store.close();
  });

  it('refuses without any logged instructions to read', async () => {
    const store = new Store(':memory:');
    const agent = createAgent({ name: 'Quiet', projectId: 'p', endpoints: [{ id: 'e', name: 'E' }] }, store, []);
    await assert.rejects(C.checkCoverage(agent, [], store), /No logged instructions/);
    store.close();
  });
});
