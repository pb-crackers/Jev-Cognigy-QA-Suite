/**
 * Installing and removing LLM logging on Cognigy nodes, against a fake
 * Management API that records every write. No network — and nothing here can
 * touch a real project.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { hookUrl, installLogging, loggingStatus, uninstallLogging } from '../src/agents/logging.ts';
import { createAgent } from '../src/agents/service.ts';
import { Store } from '../src/store/db.ts';

const PUBLIC = 'https://agentwatch.example.com';

/** A Flow with three LLM nodes: logging off, logging to a relay, and a Say. */
function fakeCognigy(options: { mergeOnPatch?: boolean; dropWrites?: boolean } = {}) {
  const configs: Record<string, Record<string, unknown>> = {
    job: { aiAgent: 'ref-a', temperature: 0.2, advancedLogging: false, loggingWebhookUrl: '', loggingHeaders: '{}',
      loggingCustomData: '', conditionForLogging: '', lots: { of: ['other', 'settings'] } },
    prompt: { prompt: 'Summarise', advancedLogging: true, loggingWebhookUrl: 'https://relay.example.com/hook/x',
      loggingHeaders: '{"X-Webhook-Token":"relay"}', loggingCustomData: '', conditionForLogging: '' },
  };
  const writes: { nodeId: string; config: Record<string, unknown> }[] = [];
  const api = {
    async flows() { return [{ id: 'f1', referenceId: 'ref-main', name: 'Main' }]; },
    async flowNodes() {
      return [
        { id: 'job', type: 'aiAgentJob', label: 'AI Agent' },
        { id: 'prompt', type: 'llmPromptV2', label: 'Summarise' },
        { id: 'say', type: 'say', label: 'Say' },
      ];
    },
    async node(_flowId: string, nodeId: string) {
      return { id: nodeId, type: 'x', label: nodeId, config: structuredClone(configs[nodeId] ?? {}) };
    },
    async updateNodeConfig(_flowId: string, nodeId: string, config: Record<string, unknown>) {
      writes.push({ nodeId, config: structuredClone(config) });
      if (options.dropWrites) return;
      configs[nodeId] = options.mergeOnPatch ? { ...configs[nodeId], ...config } : structuredClone(config);
    },
  };
  return { api, configs, writes };
}

function setup() {
  const store = new Store(':memory:');
  const agent = createAgent(
    { name: 'Home Loans', projectId: 'p1', endpoints: [{ id: 'e', name: 'REST', flowRef: 'ref-main' }] }, store, [],
  );
  return { store, agent };
}

describe('the webhook URL', () => {
  it('names the agent in the path and asks Cognigy to fill in user and session', () => {
    assert.equal(
      hookUrl('https://agentwatch.example.com/', 'home-loans'),
      'https://agentwatch.example.com/hook/home-loans?userId={{input.userId}}&sessionId={{input.sessionId}}',
    );
  });
});

describe('logging status', () => {
  it('reports each LLM node as off, logging elsewhere, or ours — and ignores Say', async () => {
    const { store, agent } = setup();
    const status = await loggingStatus(agent, fakeCognigy().api);
    assert.deepEqual(status.map((node) => `${node.nodeId}:${node.state}`), ['job:off', 'prompt:other']);
    assert.equal(status[1].currentUrl, 'https://relay.example.com/hook/x');
    store.close();
  });
});

describe('installing', () => {
  it('writes the whole config back, changing only the logging fields', async () => {
    const { store, agent } = setup();
    const cognigy = fakeCognigy();
    const { report } = await installLogging(agent, cognigy.api, store, { publicUrl: PUBLIC });

    assert.deepEqual(report.installed.map((node) => node.nodeId), ['job']);
    const written = cognigy.writes.find((write) => write.nodeId === 'job')!.config;
    assert.equal(written.temperature, 0.2, 'untouched fields are sent back as they were');
    assert.deepEqual(written.lots, { of: ['other', 'settings'] });
    assert.equal(written.advancedLogging, true);
    assert.match(String(written.loggingWebhookUrl), /\/hook\/home-loans\?userId=/);
    assert.equal(written.loggingCustomData, '', 'custom data is left alone');
    store.close();
  });

  it('stores the header as a JSON string carrying the agent\'s secret', async () => {
    const { store, agent } = setup();
    const cognigy = fakeCognigy();
    await installLogging(agent, cognigy.api, store, { publicUrl: PUBLIC });
    const headers = cognigy.writes[0].config.loggingHeaders;
    assert.equal(typeof headers, 'string');
    assert.deepEqual(JSON.parse(String(headers)), { 'X-Webhook-Token': agent.trace.token });
    store.close();
  });

  it('works whether the API merges or replaces the config', async () => {
    for (const mergeOnPatch of [true, false]) {
      const { store, agent } = setup();
      const cognigy = fakeCognigy({ mergeOnPatch });
      await installLogging(agent, cognigy.api, store, { publicUrl: PUBLIC });
      assert.equal(cognigy.configs.job.temperature, 0.2, `temperature survives (merge=${mergeOnPatch})`);
      assert.equal(cognigy.configs.job.aiAgent, 'ref-a');
      store.close();
    }
  });

  it('leaves a node that logs elsewhere alone unless asked to take it over', async () => {
    const { store, agent } = setup();
    const cognigy = fakeCognigy();
    const first = await installLogging(agent, cognigy.api, store, { publicUrl: PUBLIC });
    assert.deepEqual(first.report.skipped.map((node) => node.nodeId), ['prompt']);
    assert.equal(cognigy.configs.prompt.loggingWebhookUrl, 'https://relay.example.com/hook/x');

    const second = await installLogging(first.agent, cognigy.api, store, { publicUrl: PUBLIC, takeOver: true });
    assert.deepEqual(second.report.installed.map((node) => node.nodeId), ['prompt']);
    assert.deepEqual(second.report.alreadyOurs.map((node) => node.nodeId), ['job'], 'a second install is a no-op for ours');
    store.close();
  });

  it('refuses without a public URL, since Cognigy would have nowhere to post', async () => {
    const { store, agent } = setup();
    await assert.rejects(installLogging(agent, fakeCognigy().api, store, { publicUrl: '' }), /AGENT_WATCH_PUBLIC_URL/);
    store.close();
  });

  it('reports a write the node did not keep, and records no install for it', async () => {
    const { store, agent } = setup();
    const { report, agent: next } = await installLogging(agent, fakeCognigy({ dropWrites: true }).api, store, { publicUrl: PUBLIC });
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0].error, /did not keep/);
    assert.equal(next.trace.installs.length, 0);
    store.close();
  });
});

describe('ownership', () => {
  it('does not mistake another agent whose id starts with ours for us', async () => {
    const store = new Store(':memory:');
    const summit = createAgent({ name: 'Summit', projectId: 'p1', endpoints: [{ id: 'e1', name: 'A', flowRef: 'ref-main' }] }, store, []);
    const cognigy = fakeCognigy();
    // Another agent, "summit-2", already logs the node.
    cognigy.configs.job.advancedLogging = true;
    cognigy.configs.job.loggingWebhookUrl = `${PUBLIC}/hook/summit-2?userId={{input.userId}}`;
    const status = await loggingStatus(summit, cognigy.api);
    assert.equal(status.find((node) => node.nodeId === 'job')!.state, 'other', 'summit-2 is not summit');

    const { report } = await installLogging(summit, cognigy.api, store, { publicUrl: PUBLIC });
    assert.deepEqual(report.alreadyOurs, []);
    assert.ok(report.skipped.some((node) => node.nodeId === 'job'), 'left alone, not claimed');
    store.close();
  });
});

describe('restoring a node that never had logging fields', () => {
  it('switches logging off instead of leaving ours on', async () => {
    const store = new Store(':memory:');
    const agent = createAgent({ name: 'Home Loans', projectId: 'p1', endpoints: [{ id: 'e', name: 'REST', flowRef: 'ref-main' }] }, store, []);
    const cognigy = fakeCognigy({ mergeOnPatch: true });
    // An older node whose config simply lacks the logging keys.
    delete cognigy.configs.job.advancedLogging;
    delete cognigy.configs.job.loggingWebhookUrl;
    delete cognigy.configs.job.loggingHeaders;
    const { agent: installed } = await installLogging(agent, cognigy.api, store, { publicUrl: PUBLIC });
    // Round-trip through storage, which is JSON and drops undefined values.
    const reloaded = store.agent(installed.id)!;
    const { report } = await uninstallLogging(reloaded, cognigy.api, store);
    assert.equal(report.restored.length, 1);
    assert.equal(cognigy.configs.job.advancedLogging, false);
    assert.equal(cognigy.configs.job.loggingWebhookUrl, '');
    store.close();
  });
});

describe('uninstalling', () => {
  it('puts back exactly what was there, including a relay that was taken over', async () => {
    const { store, agent } = setup();
    const cognigy = fakeCognigy();
    const before = structuredClone(cognigy.configs);
    const { agent: installed } = await installLogging(agent, cognigy.api, store, { publicUrl: PUBLIC, takeOver: true });
    const { report, agent: after } = await uninstallLogging(installed, cognigy.api, store);

    assert.equal(report.restored.length, 2);
    assert.deepEqual(cognigy.configs, before, 'every node is byte-for-byte as it started');
    assert.equal(after.trace.installs.length, 0);
    store.close();
  });

  it('keeps the original "before" across a repeated install', async () => {
    const { store, agent } = setup();
    const cognigy = fakeCognigy();
    const once = await installLogging(agent, cognigy.api, store, { publicUrl: PUBLIC });
    cognigy.configs.job.advancedLogging = false; // someone switched it off in the editor
    const twice = await installLogging(once.agent, cognigy.api, store, { publicUrl: PUBLIC });
    assert.equal(twice.agent.trace.installs[0].previous.loggingWebhookUrl, '', 'still the original empty URL');
    store.close();
  });

  it('does not overwrite a node someone repointed after install', async () => {
    const { store, agent } = setup();
    const cognigy = fakeCognigy();
    const { agent: installed } = await installLogging(agent, cognigy.api, store, { publicUrl: PUBLIC });
    cognigy.configs.job.loggingWebhookUrl = 'https://someone-else.example.com/hook';
    const { report } = await uninstallLogging(installed, cognigy.api, store);
    assert.equal(report.leftAlone.length, 1);
    assert.equal(cognigy.configs.job.loggingWebhookUrl, 'https://someone-else.example.com/hook');
    store.close();
  });
});
