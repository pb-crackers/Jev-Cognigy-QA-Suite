/**
 * The health model: how per-rubric answers become one figure, and what that
 * figure is honest about. In-memory store; no network.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeHealth, MIN_SAMPLE } from '../src/health/health.ts';
import { createAgent } from '../src/agents/service.ts';
import { Store } from '../src/store/db.ts';
import type { Rubric } from '../src/rubrics/model.ts';

const NOW = new Date('2026-09-23T12:00:00Z');
const helped: Rubric = { id: 'helped', name: 'Helped', question: 'Helped?', type: 'boolean', combine: 'last', weight: 2, enabled: true, origin: 'library' };
const tone: Rubric = { id: 'tone', name: 'Tone', question: 'Tone?', type: 'boolean', combine: 'last', weight: 2, enabled: true, origin: 'library' };
const attempt: Rubric = { id: 'jailbreak_attempt', name: 'Attempt', question: 'Attempt?', type: 'boolean', combine: 'any',
  weight: 0, enabled: true, invert: true, origin: 'library', kind: 'alert', alert: { threshold: 10, window: 'day' } };
const rubrics = [helped, tone, attempt];

function setup() {
  const store = new Store(':memory:');
  const agent = createAgent({ name: 'Summit', projectId: 'p', endpoints: [{ id: 'e', name: 'E' }] }, store, rubrics);
  return { store, agent };
}

let seq = 0;
function session(store: Store, agentId: string, startedAt: string, answers: Record<string, string>, extra: { coverage?: 'full' } = {}) {
  const id = `s${seq++}`;
  const runId = `run-${id}`;
  store.saveRun({ id: runId, startedAt, projectId: 'p', projectName: 'P', endpointLabel: 'E', fromTs: 'a', toTs: 'b',
    sessions: 1, costUsd: 0, ms: 1, agentId });
  store.saveSession({ runId, sessionId: id, startedAt, endpointLabel: 'E', channel: 'rest', channelLabel: 'REST API',
    flowName: 'F', turns: 2, chunks: 1, rating: null, ratingComment: null, unscoreable: null, transcript: '[]', costUsd: 0,
    ms: 1, traceCoverage: extra.coverage ?? null },
  Object.entries(answers).map(([rubricId, raw]) => ({ runId, sessionId: id, rubricId, raw, confidence: null, chunks: 1, decidedBy: null })));
  return id;
}

describe('health', () => {
  it('is the mean session composite, weighted by each rubric\'s weight × validity', () => {
    const { store, agent } = setup();
    session(store, agent.id, '2026-09-23T10:00:00Z', { helped: '1', tone: '0' });
    session(store, agent.id, '2026-09-23T11:00:00Z', { helped: '1', tone: '1' });
    // Equal weights, both unchecked (0.5): session 1 = 0.5, session 2 = 1.0.
    assert.equal(computeHealth(agent, rubrics, store, '24h', NOW).health, 0.75);

    // Checking helped at validity 1 makes it count twice as much as unchecked tone.
    store.saveValidity('helped', { validity: 1 }, NOW.toISOString());
    const checked = computeHealth(agent, rubrics, store, '24h', NOW);
    assert.equal(Number(checked.health!.toFixed(4)), Number(((2 / 3 + 1) / 2).toFixed(4)));
    assert.equal(Number(checked.verifiedShare.toFixed(4)), Number((2 / 3).toFixed(4)));
    store.close();
  });

  it('never lets a weightless rubric — a user\'s jailbreak attempt — move it', () => {
    const { store, agent } = setup();
    session(store, agent.id, '2026-09-23T10:00:00Z', { helped: '1', tone: '1', jailbreak_attempt: '0.99' });
    const result = computeHealth(agent, rubrics, store, '24h', NOW);
    assert.equal(result.health, 1);
    store.close();
  });

  it('is indicative only below the minimum sample, and reportable above it', () => {
    const { store, agent } = setup();
    for (let i = 0; i < MIN_SAMPLE - 1; i++) session(store, agent.id, '2026-09-23T10:00:00Z', { helped: i % 2 ? '1' : '0.8' });
    assert.equal(computeHealth(agent, rubrics, store, '24h', NOW).reportable, false);
    session(store, agent.id, '2026-09-23T10:00:00Z', { helped: '1' });
    const enough = computeHealth(agent, rubrics, store, '24h', NOW);
    assert.equal(enough.reportable, true);
    assert.ok(enough.interval! > 0 && enough.interval! < 0.1, 'a narrow interval over thirty similar sessions');
    store.close();
  });

  it('only counts sessions inside the window', () => {
    const { store, agent } = setup();
    session(store, agent.id, '2026-09-10T10:00:00Z', { helped: '0' });
    session(store, agent.id, '2026-09-23T10:00:00Z', { helped: '1' });
    assert.equal(computeHealth(agent, rubrics, store, '24h', NOW).sessions, 1);
    assert.equal(computeHealth(agent, rubrics, store, '30d', NOW).sessions, 2);
    store.close();
  });

  it('lists failing sessions worst first, naming the rubrics that failed', () => {
    const { store, agent } = setup();
    const bad = session(store, agent.id, '2026-09-23T10:00:00Z', { helped: '0', tone: '0.1' });
    session(store, agent.id, '2026-09-23T11:00:00Z', { helped: '1', tone: '1' });
    const [first] = computeHealth(agent, rubrics, store, '24h', NOW).failing;
    assert.equal(first.sessionId, bad);
    assert.deepEqual(first.worst, ['helped', 'tone']);
    store.close();
  });

  it('counts passes as sessions, not an average of scores', () => {
    const { store, agent } = setup();
    session(store, agent.id, '2026-09-23T09:00:00Z', { helped: '0.9' });
    session(store, agent.id, '2026-09-23T10:00:00Z', { helped: '0.6' });
    session(store, agent.id, '2026-09-23T11:00:00Z', { helped: '0.1' });
    const helped = computeHealth(agent, rubrics, store, '24h', NOW).rubrics.find((r) => r.rubricId === 'helped')!;
    assert.deepEqual([helped.passed, helped.answered], [2, 3], 'the mean would be 0.53; two of three passed');
    assert.equal(helped.passRate, 2 / 3);
    store.close();
  });

  it('reports a daily trend, per-rubric pass rates and traced sessions', () => {
    const { store, agent } = setup();
    session(store, agent.id, '2026-09-21T10:00:00Z', { helped: '0' });
    session(store, agent.id, '2026-09-22T10:00:00Z', { helped: '1' }, { coverage: 'full' });
    const result = computeHealth(agent, rubrics, store, '7d', NOW);
    assert.deepEqual(result.trend.map((point) => [point.day, point.health]), [['2026-09-21', 0], ['2026-09-22', 1]]);
    const helped = result.rubrics.find((r) => r.rubricId === 'helped')!;
    assert.deepEqual([helped.passed, helped.answered, helped.passRate], [1, 2, 0.5]);
    assert.equal(result.traced, 1);
    store.close();
  });

  it('has no figure at all with nothing scored', () => {
    const { store, agent } = setup();
    const result = computeHealth(agent, rubrics, store, '24h', NOW);
    assert.equal(result.health, null);
    assert.equal(result.interval, null);
    store.close();
  });
});
