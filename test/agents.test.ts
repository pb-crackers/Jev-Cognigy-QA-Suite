/**
 * The agent model, its storage, and the traffic filter that selects its
 * sessions. Pure or in-memory; no network, no spend.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  agentRubrics, defaultOn, endpointOwner, initialToggles, rubricOn, slugify, type Agent,
} from '../src/agents/model.ts';
import { endpointClause } from '../src/cognigy/odata.ts';
import { Store } from '../src/store/db.ts';
import type { Rubric } from '../src/rubrics/model.ts';

const rubric = (over: Partial<Rubric>): Rubric => ({
  id: 'r', name: 'R', question: 'Q?', type: 'boolean', combine: 'last', weight: 1, enabled: true, ...over,
});

export const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'summit', name: 'Summit', projectId: 'p1', projectName: 'P', endpoints: [],
  includePanel: false, rubrics: {}, enabled: true, intervalMinutes: 60,
  alerts: { macos: true }, trace: { token: 't', installs: [] }, createdAt: '2026-09-22T00:00:00Z',
  ...over,
});

describe('agent ids', () => {
  it('slugs a display name into a URL-safe path segment', () => {
    assert.equal(slugify('Summit Ridge Mortgage Assistant'), 'summit-ridge-mortgage-assistant');
    assert.equal(slugify('  API – JEV Inference!! '), 'api-jev-inference');
    assert.equal(slugify('***'), 'agent');
  });
});

describe('which rubrics an agent is graded on', () => {
  const library = rubric({ id: 'jailbreak', origin: 'library' });
  const custom = rubric({ id: 'discount', origin: 'custom' });
  const legacy = rubric({ id: 'old' });

  it('switches a new library rubric on and a new custom rubric off', () => {
    assert.equal(defaultOn(library), true);
    assert.equal(defaultOn(custom), false);
    assert.equal(rubricOn(agent(), library), true);
    assert.equal(rubricOn(agent(), custom), false);
  });

  it('honours an explicit switch over the default, in both directions', () => {
    assert.equal(rubricOn(agent({ rubrics: { jailbreak: false } }), library), false);
    assert.equal(rubricOn(agent({ rubrics: { discount: true } }), custom), true);
  });

  it('never runs a rubric disabled in the library, whatever the agent says', () => {
    assert.equal(rubricOn(agent({ rubrics: { r: true } }), rubric({ enabled: false })), false);
  });

  it('starts a new agent with everything enabled at that moment switched on', () => {
    const toggles = initialToggles([custom, legacy, rubric({ id: 'off', enabled: false })]);
    assert.deepEqual(toggles, { discount: true, old: true });
    const a = agent({ rubrics: toggles });
    assert.deepEqual(agentRubrics(a, [custom, legacy, library]).map((r) => r.id), ['discount', 'old', 'jailbreak']);
  });

  it('keeps one agent\'s switches from touching another\'s', () => {
    const retail = agent({ id: 'retail', rubrics: { discount: true } });
    const mortgage = agent({ id: 'mortgage', rubrics: {} });
    assert.equal(rubricOn(retail, custom), true);
    assert.equal(rubricOn(mortgage, custom), false);
  });
});

describe('endpoint ownership', () => {
  it('names the agent that already owns an endpoint', () => {
    const owner = agent({ id: 'summit', endpoints: [{ id: 'e1', name: 'REST' }] });
    assert.equal(endpointOwner([owner], 'e1')?.id, 'summit');
    assert.equal(endpointOwner([owner], 'e2'), undefined);
  });

  it('does not count an agent as owning against itself while it is edited', () => {
    const owner = agent({ id: 'summit', endpoints: [{ id: 'e1', name: 'REST' }] });
    assert.equal(endpointOwner([owner], 'e1', 'summit'), undefined);
  });
});

describe('agent traffic filter', () => {
  it('selects any of the agent\'s endpoints with chained or, never in()', () => {
    assert.equal(endpointClause(['REST', 'VG'], false), "(endpointName eq 'REST' or endpointName eq 'VG')");
    assert.ok(!endpointClause(['REST', 'VG'], false)!.includes(' in '));
  });

  it('adds the Interaction Panel only when asked', () => {
    assert.equal(endpointClause(['REST'], true), "(endpointName eq 'REST' or endpointName eq null)");
    assert.equal(endpointClause([], true), 'endpointName eq null');
  });

  it('takes only panel sessions from the agent\'s own Flows', () => {
    assert.equal(
      endpointClause(['REST'], true, ['Main', 'Sub']),
      "(endpointName eq 'REST' or (endpointName eq null and (flowName eq 'Main' or flowName eq 'Sub')))",
    );
    assert.equal(endpointClause([], true, ['Main']), "(endpointName eq null and flowName eq 'Main')");
  });

  it('has no traffic at all without endpoints or the panel', () => {
    assert.equal(endpointClause([], false), null);
  });

  it('escapes a quote in an endpoint name', () => {
    assert.equal(endpointClause(["Bob's bot"], false), "endpointName eq 'Bob''s bot'");
  });
});

describe('agent storage', () => {
  it('round-trips an agent and deletes it with its collector state', () => {
    const store = new Store(':memory:');
    store.saveAgent(agent());
    store.saveAgentState({ agentId: 'summit', watermark: '2026-09-22T10:00:00Z', lastCollectedAt: null, lastError: null });
    assert.equal(store.agent('summit')?.name, 'Summit');
    assert.equal(store.agentState('summit').watermark, '2026-09-22T10:00:00Z');
    store.deleteAgent('summit');
    assert.equal(store.agent('summit'), undefined);
    assert.equal(store.agentState('summit').watermark, null);
    store.close();
  });

  it('merges a session\'s answers across runs, keeping the newest per rubric', () => {
    const store = new Store(':memory:');
    const session = (runId: string) => ({
      runId, sessionId: 's1', startedAt: '2026-09-22T10:00:00Z', endpointLabel: 'E', channel: 'rest',
      channelLabel: 'REST API', flowName: 'F', turns: 2, chunks: 1, rating: null, ratingComment: null,
      unscoreable: null, transcript: '[]', costUsd: 0, ms: 1, lastAt: '2026-09-22T10:05:00Z',
    });
    const run = (id: string, startedAt: string, agentId: string | null) => ({
      id, startedAt, projectId: 'p1', projectName: 'P', endpointLabel: 'E', fromTs: 'a', toTs: 'b',
      sessions: 1, costUsd: 0, ms: 1, agentId,
    });
    store.saveRun(run('adhoc', '2026-09-22T11:00:00Z', null));
    store.saveSession(session('adhoc'), [
      { runId: 'adhoc', sessionId: 's1', rubricId: 'helped', raw: '0.2', confidence: null, chunks: 1, decidedBy: null },
      { runId: 'adhoc', sessionId: 's1', rubricId: 'tone', raw: '1', confidence: 0.9, chunks: 1, decidedBy: null },
    ]);
    store.saveRun(run('agentrun', '2026-09-22T12:00:00Z', 'summit'));
    store.saveSession(session('agentrun'), [
      { runId: 'agentrun', sessionId: 's1', rubricId: 'helped', raw: '0.8', confidence: null, chunks: 1, decidedBy: null },
      { runId: 'agentrun', sessionId: 's1', rubricId: 'jailbreak', raw: '0.01', confidence: null, chunks: 1, decidedBy: null },
    ]);

    const latest = new Map(store.latestResults(['s1']).map((r) => [r.rubricId, r.raw]));
    assert.deepEqual(Object.fromEntries(latest), { helped: '0.8', tone: '1', jailbreak: '0.01' });

    const scored = store.scoredRubrics(['s1', 's2']).get('s1');
    assert.deepEqual([...scored!.rubrics].sort(), ['helped', 'jailbreak', 'tone']);
    assert.equal(scored!.lastAt, '2026-09-22T10:05:00Z');
    assert.equal(store.agentSessions('summit').length, 1);
    assert.equal(store.runs().find((r) => r.id === 'agentrun')?.agentId, 'summit');
    store.close();
  });
});
