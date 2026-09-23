/**
 * Agent suggestions and the Go-To-following node traversal, against a fake
 * Management API. No network.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { findLlmNodes } from '../src/agents/nodes.ts';
import { suggestAgents } from '../src/agents/suggest.ts';
import { agentProblems, agentRunRequest, createAgent, resolveEndpoints, updateAgent } from '../src/agents/service.ts';
import { Store } from '../src/store/db.ts';
import type { Rubric } from '../src/rubrics/model.ts';

/** A tiny project: two endpoints into one AI Agent Flow that Go-Tos a second Flow. */
function fakeApi() {
  const flows = [
    { id: 'f1', referenceId: 'ref-main', name: 'Main' },
    { id: 'f2', referenceId: 'ref-sub', name: 'Sub' },
  ];
  const nodes: Record<string, { id: string; type: string; label: string; config: Record<string, unknown> }[]> = {
    f1: [
      { id: 'n1', type: 'aiAgentJob', label: 'AI Agent', config: { aiAgent: 'agent-ref' } },
      { id: 'n2', type: 'goTo', label: 'Go To', config: { flowNode: { flow: 'ref-sub' } } },
      { id: 'n3', type: 'say', label: 'Say', config: {} },
    ],
    f2: [
      { id: 'n4', type: 'llmPromptV2', label: 'Summarise', config: {} },
      { id: 'n5', type: 'goTo', label: 'Back', config: { flowNode: { flow: 'ref-main' } } },
    ],
  };
  return {
    async endpoints() {
      return [
        { id: 'e-rest', name: 'REST', flowRef: 'ref-main', channel: 'rest' },
        { id: 'e-voice', name: 'Voice', flowRef: 'ref-main', channel: 'voiceGateway2' },
        { id: 'e-hook', name: 'Webhook' },
        { id: 'e-gone', name: 'Orphan', flowRef: 'ref-deleted' },
      ];
    },
    async flows() { return flows; },
    async aiAgents() { return [{ id: 'a1', referenceId: 'agent-ref', name: 'Summit Assistant' }]; },
    async flowNodes(flowId: string) { return nodes[flowId].map(({ id, type, label }) => ({ id, type, label })); },
    async node(flowId: string, nodeId: string) { return nodes[flowId].find((node) => node.id === nodeId)!; },
  };
}

const rubric = (over: Partial<Rubric>): Rubric => ({
  id: 'r', name: 'R', question: 'Q?', type: 'boolean', combine: 'last', weight: 1, enabled: true, ...over,
});

describe('finding LLM nodes', () => {
  it('follows Go To into other Flows, and visits each Flow once despite a cycle', async () => {
    const api = fakeApi();
    const found = await findLlmNodes(api, await api.flows(), ['ref-main']);
    assert.deepEqual(found.map((node) => `${node.flowName}/${node.nodeType}`), ['Main/aiAgentJob', 'Sub/llmPromptV2']);
  });
});

describe('suggestions', () => {
  it('groups endpoints that run the same AI Agent into one agent named after it', async () => {
    const [first] = await suggestAgents(fakeApi(), 'p1', []);
    assert.equal(first.name, 'Summit Assistant');
    assert.equal(first.id, 'summit-assistant');
    assert.deepEqual(first.endpoints.map((endpoint) => endpoint.name), ['REST', 'Voice']);
    assert.equal(first.llmNodes, 2 * 2, 'both endpoints reach the same two LLM nodes');
  });

  it('lists an endpoint with no Flow, or a Flow that no longer exists, last and flagged', async () => {
    const suggestions = await suggestAgents(fakeApi(), 'p1', []);
    const tail = suggestions.slice(-2);
    assert.ok(tail.every((suggestion) => suggestion.noFlow));
    assert.deepEqual(tail.map((suggestion) => suggestion.name).sort(), ['Orphan', 'Webhook']);
  });

  it('marks a suggestion whose endpoint another agent already owns', async () => {
    const store = new Store(':memory:');
    createAgent(
      { name: 'Existing', projectId: 'p1', endpoints: [{ id: 'e-rest', name: 'REST' }] }, store, [],
    );
    const [first] = await suggestAgents(fakeApi(), 'p1', store.agents());
    assert.equal(first.ownedBy, 'existing');
    store.close();
  });
});

describe('agent rules', () => {
  it('reports every problem at once', () => {
    const problems = agentProblems({ name: '', projectId: '', endpoints: [] }, []);
    assert.equal(problems.length, 3);
  });

  it('refuses an endpoint that already belongs to another agent, naming it', () => {
    const store = new Store(':memory:');
    createAgent({ name: 'Summit', projectId: 'p1', endpoints: [{ id: 'e1', name: 'REST' }] }, store, []);
    assert.throws(
      () => createAgent({ name: 'Other', projectId: 'p1', endpoints: [{ id: 'e1', name: 'REST' }] }, store, []),
      /already belongs to agent "Summit"/,
    );
    store.close();
  });

  it('accepts a panel-only agent and rejects one with no traffic at all', () => {
    assert.deepEqual(agentProblems({ name: 'A', projectId: 'p', endpoints: [], includePanel: true }, []), []);
    assert.ok(agentProblems({ name: 'A', projectId: 'p', endpoints: [] }, []).some((p) => p.includes('at least one endpoint')));
  });

  it('gives a new agent a unique id and its own trace token', () => {
    const store = new Store(':memory:');
    const a = createAgent({ name: 'Summit', projectId: 'p', endpoints: [{ id: 'e1', name: 'A' }] }, store, []);
    const b = createAgent({ name: 'Summit', projectId: 'p', endpoints: [{ id: 'e2', name: 'B' }] }, store, []);
    assert.equal(a.id, 'summit');
    assert.equal(b.id, 'summit-2');
    assert.notEqual(a.trace.token, b.trace.token);
    store.close();
  });

  it('merges rubric switches on update rather than replacing them', () => {
    const store = new Store(':memory:');
    createAgent({ name: 'S', projectId: 'p', endpoints: [{ id: 'e', name: 'E' }], rubrics: { a: true, b: true } }, store, []);
    const next = updateAgent('s', { rubrics: { b: false } }, store);
    assert.deepEqual(next.rubrics, { a: true, b: false });
    store.close();
  });

  it('follows a renamed endpoint and says so', async () => {
    const store = new Store(':memory:');
    const agent = createAgent({ name: 'S', projectId: 'p', endpoints: [{ id: 'e-rest', name: 'Old name' }] }, store, []);
    const { agent: next, warnings } = await resolveEndpoints(agent, fakeApi(), store);
    assert.equal(next.endpoints[0].name, 'REST');
    assert.match(warnings[0], /renamed to "REST"/);
    assert.equal(store.agent('s')?.endpoints[0].name, 'REST');
    store.close();
  });

  it('builds a run over the agent\'s traffic and only its rubrics', () => {
    const store = new Store(':memory:');
    const agent = createAgent(
      { name: 'S', projectId: 'p', endpoints: [{ id: 'e', name: 'REST' }], includePanel: true, rubrics: { mine: true } },
      store, [],
    );
    const request = agentRunRequest(agent, [
      rubric({ id: 'mine', origin: 'custom' }), rubric({ id: 'theirs', origin: 'custom' }), rubric({ id: 'lib', origin: 'library' }),
    ], { from: 'a', to: 'b' });
    assert.deepEqual(request.endpointNames, ['REST']);
    assert.equal(request.includePanel, true);
    assert.deepEqual(request.rubricIds, ['mine', 'lib']);
    assert.equal(request.skipMode, 'rubric');
    assert.equal(request.agentId, 's');
    store.close();
  });
});
