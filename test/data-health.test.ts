/**
 * Data health: what an agent's scores rest on, and what went wrong getting there.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeDataHealth } from '../src/health/data.ts';
import { createAgent } from '../src/agents/service.ts';
import { Store } from '../src/store/db.ts';
import type { SessionChecks } from '../src/checks/exact.ts';
import type { SessionRow } from '../src/store/db.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const checks = (over: Partial<SessionChecks> = {}): string => JSON.stringify({
  latency: { turns: 2, medianMs: 1500, maxMs: 2000 }, transcriptGaps: [], drift: 0, driftPaths: [], failedCalls: 0, ...over,
});

function session(runId: string, sessionId: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    runId, sessionId, startedAt: '2026-09-23T11:00:00.000Z', endpointLabel: 'REST', channel: 'rest', channelLabel: 'REST API',
    flowName: 'F', turns: 4, chunks: 1, rating: null, ratingComment: null, unscoreable: null, transcript: '[]',
    costUsd: 0, ms: 0, lastAt: '2026-09-23T11:05:00.000Z', traceCoverage: 'full', checks: checks(), ...over,
  };
}

describe('data health', () => {
  it('counts what makes the scores less trustworthy, and keeps agent behaviour apart', () => {
    const store = new Store(':memory:');
    const agent = createAgent({ name: 'Servicing', projectId: 'p', endpoints: [{ id: 'e', name: 'REST' }] }, store, []);
    store.saveRun({ id: 'r1', startedAt: '2026-09-23T11:10:00.000Z', projectId: 'p', projectName: 'P', endpointLabel: 'x', fromTs: 'a', toTs: 'b', sessions: 5, costUsd: 0, ms: 0, agentId: agent.id });
    store.saveSession(session('r1', 'clean'), []);
    store.saveSession(session('r1', 'partial', { traceCoverage: 'partial', checks: checks({ failedCalls: 2 }) }), []);
    store.saveSession(session('r1', 'drifted', { checks: checks({ drift: 1, driftPaths: ['response.toolCalls[0].function.arguments'] }) }), []);
    store.saveSession(session('r1', 'gappy', { checks: checks({ transcriptGaps: ['in-9'] }) }), []);
    store.saveSession(session('r1', 'broken', { error: 'Jev timed out', attempts: 2, checks: null }), []);

    const data = computeDataHealth(agent.id, store, '24h', NOW);
    assert.equal(data.sessions, 5);
    assert.deepEqual(data.logged, { full: 3, partial: 1, none: 0 });
    assert.deepEqual(data.failed, { count: 1, latest: [{ sessionId: 'broken', error: 'Jev timed out', attempts: 2 }] });
    assert.deepEqual(data.drift, { sessions: 1, paths: ['response.toolCalls[0].function.arguments'] });
    assert.deepEqual(data.gaps, { sessions: 1, sessionIds: ['gappy'] });
    assert.equal(data.failedCalls, 2, 'reported, but a failed tool call is the agent, not the data');
    assert.equal(data.problems, 3);
    store.close();
  });

  it('has nothing to report for an agent with no sessions', () => {
    const store = new Store(':memory:');
    const agent = createAgent({ name: 'Quiet', projectId: 'p', endpoints: [{ id: 'e', name: 'REST' }] }, store, []);
    assert.equal(computeDataHealth(agent.id, store, '24h', NOW).problems, 0);
    store.close();
  });
});
