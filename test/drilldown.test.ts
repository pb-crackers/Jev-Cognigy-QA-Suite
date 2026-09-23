/**
 * The lists behind drilling down: an agent's sessions, and one rubric's sessions
 * with labelled answers and any stored pointer to the message behind them.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { certaintyOf, rubricSessions, sessionList } from '../src/health/drilldown.ts';
import { locateKey } from '../src/scoring/locate.ts';
import { createAgent } from '../src/agents/service.ts';
import { Store } from '../src/store/db.ts';
import type { Rubric } from '../src/rubrics/model.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const rate: Rubric = { id: 'quoted_rate', name: 'Quoted a specific rate', question: 'Did the agent quote a rate?', type: 'boolean', combine: 'any', weight: 2, enabled: true, invert: true, origin: 'library' };
const helped: Rubric = { id: 'helped', name: 'Helped', question: 'Was the customer helped?', type: 'boolean', combine: 'last', weight: 1, enabled: true, origin: 'library' };
const rubrics = [rate, helped];

function setup() {
  const store = new Store(':memory:');
  const agent = createAgent({ name: 'Avery', projectId: 'p', endpoints: [{ id: 'e', name: 'E' }] }, store, rubrics);
  let seq = 0;
  const session = (startedAt: string, answers: Record<string, string>, extra: { transcript?: unknown[]; checks?: object; error?: string } = {}) => {
    const id = `s${seq++}`;
    store.saveRun({ id: `r${id}`, startedAt, projectId: 'p', projectName: 'P', endpointLabel: 'E', fromTs: 'a', toTs: 'b', sessions: 1, costUsd: 0, ms: 1, agentId: agent.id });
    store.saveSession({ runId: `r${id}`, sessionId: id, startedAt, endpointLabel: 'E', channel: 'rest', channelLabel: 'REST API', flowName: 'F', turns: 2, chunks: 1,
      rating: null, ratingComment: null, unscoreable: null, transcript: JSON.stringify(extra.transcript ?? []), costUsd: 0, ms: 1,
      checks: extra.checks ? JSON.stringify({ latency: { turns: 0 }, transcriptGaps: [], drift: 0, driftPaths: [], failedCalls: 0, ...extra.checks }) : null,
      error: extra.error ?? null },
    Object.entries(answers).map(([rubricId, raw]) => ({ runId: `r${id}`, sessionId: id, rubricId, raw, confidence: null, chunks: 1, decidedBy: null })));
    return id;
  };
  return { store, agent, session };
}

describe('labelling how sure Jev was', () => {
  it('gives a yes/no answer the probability of the answer given, not of yes', () => {
    assert.deepEqual(certaintyOf(rate, { raw: 0.86, confidence: null }), { label: 'probability', value: 0.86 });
    const no = certaintyOf(rate, { raw: 0.42, confidence: null })!;
    assert.equal(no.label, 'probability');
    assert.ok(Math.abs(no.value - 0.58) < 1e-9, 'no, probability 0.58 — never "no, 0.42"');
  });

  it('gives a score or choice its confidence in the option picked', () => {
    assert.deepEqual(certaintyOf({ ...rate, type: 'choice' }, { raw: 'too_soon', confidence: 0.87 }), { label: 'confidence', value: 0.87 });
  });
});

describe("one rubric's sessions", () => {
  it('lists failures first, then newest, with the answer in words', () => {
    const { store, agent, session } = setup();
    const quoted = session('2026-09-23T09:00:00Z', { quoted_rate: '0.86' });
    const clean = session('2026-09-23T11:00:00Z', { quoted_rate: '0.05' });
    const unasked = session('2026-09-23T10:00:00Z', { helped: '0.9' });
    const all = rubricSessions(agent, rate, store, '24h', 'all', NOW);
    assert.deepEqual(all.counts, { failed: 1, passed: 1, all: 2 });
    assert.deepEqual(all.sessions.map((row) => [row.sessionId, row.answer, row.passed]), [[quoted, 'yes', false], [clean, 'no', true]]);
    assert.ok(!all.sessions.some((row) => row.sessionId === unasked), 'a session the rubric was never asked about is not listed');
    assert.deepEqual(rubricSessions(agent, rate, store, '24h', 'failed', NOW).sessions.map((row) => row.sessionId), [quoted]);
    store.close();
  });

  it('quotes the message behind the answer — only when it was found for this same answer and question', () => {
    const { store, agent, session } = setup();
    const transcript = [{ role: 'user', text: 'rates?' }, { role: 'agent', text: 'Roughly 6.1% today.' }];
    const id = session('2026-09-23T09:00:00Z', { quoted_rate: '0.86' }, { transcript });
    store.saveLocate(agent.id, id, 'quoted_rate', { raw: '0.86', key: locateKey(rate, '0.86', transcript as never), turnIndex: 1, message: 1, confidence: 0.94 });
    const [row] = rubricSessions(agent, rate, store, '24h', 'all', NOW).sessions;
    assert.equal(row.located?.quote, 'Roughly 6.1% today.');
    assert.equal(row.located?.confidence, 0.94);
    const edited = { ...rate, question: 'Did the agent give any rate figure?' };
    assert.equal(rubricSessions(agent, edited, store, '24h', 'all', NOW).sessions[0].located, undefined, 'stale: the question changed');
    store.saveLocate(agent.id, id, 'quoted_rate', { raw: '0.40', key: locateKey(rate, '0.40', transcript as never), turnIndex: 1, message: 1, confidence: 0.9 });
    assert.equal(rubricSessions(agent, rate, store, '24h', 'all', NOW).sessions[0].located, undefined, 'stale: asked about a different answer');
    store.close();
  });

  it('says when a rubric reports answers without pass or fail', () => {
    const { store, agent, session } = setup();
    const topic: Rubric = { id: 'topic', name: 'Topic', question: 'What was it about?', type: 'choice', combine: 'last', weight: 0, enabled: true,
      options: { rates: 'Rates', payments: 'Payments' }, origin: 'library' };
    session('2026-09-23T09:00:00Z', { topic: 'rates' });
    const result = rubricSessions(agent, topic, store, '24h', 'all', NOW);
    assert.equal(result.hasVerdicts, false);
    assert.equal(result.sessions[0].passed, null);
    assert.equal(rubricSessions(agent, rate, store, '24h', 'all', NOW).hasVerdicts, false, 'nothing answered, nothing to judge');
    store.close();
  });
});

describe("an agent's sessions", () => {
  it('lists every session with what failed, and counts each filter', () => {
    const { store, agent, session } = setup();
    const failing = session('2026-09-23T09:00:00Z', { quoted_rate: '0.9', helped: '0.8' });
    const toolIssue = session('2026-09-23T10:00:00Z', { quoted_rate: '0.1', helped: '0.9' }, { checks: { failedCalls: 2 } });
    const broken = session('2026-09-23T11:00:00Z', {}, { error: 'Jev timed out' });
    const list = sessionList(agent, rubrics, store, '24h', 'all', NOW);
    assert.deepEqual(list.counts, { all: 3, rubric_failed: 1, call_failed: 1, not_scored: 1 });
    const byId = new Map(list.sessions.map((item) => [item.sessionId, item]));
    assert.deepEqual(byId.get(failing)!.failedRubrics, [{ id: 'quoted_rate', name: 'Quoted a specific rate' }]);
    assert.equal(byId.get(toolIssue)!.failedCalls, 2);
    assert.equal(byId.get(broken)!.error, 'Jev timed out');
    assert.deepEqual(sessionList(agent, rubrics, store, '24h', 'not_scored', NOW).sessions.map((item) => item.sessionId), [broken]);
    store.close();
  });
});
