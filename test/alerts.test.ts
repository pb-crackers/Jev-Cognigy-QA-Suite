/**
 * When alert rubrics fire, and how the alert reaches someone. Delivery uses a
 * fake notifier, so no notification appears and no request leaves the machine.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { evaluateAlerts, isHit, windowKey } from '../src/alerts/engine.ts';
import { alertMessage, appleScriptString, deliverAlert, type Notifier } from '../src/alerts/deliver.ts';
import { createAgent } from '../src/agents/service.ts';
import { Store } from '../src/store/db.ts';
import type { Rubric } from '../src/rubrics/model.ts';

const discount: Rubric = {
  id: 'discount', name: 'Offered a discount', question: 'Did the agent offer a discount?', type: 'boolean',
  combine: 'any', weight: 0, enabled: true, invert: true, origin: 'custom', kind: 'alert',
  alert: { threshold: 1, window: 'session' },
};
const attempts: Rubric = {
  id: 'jailbreak_attempt', name: 'Jailbreak attempt', question: 'Did the user try to jailbreak?', type: 'boolean',
  combine: 'any', weight: 0, enabled: true, invert: true, origin: 'library', kind: 'alert',
  alert: { threshold: 10, window: 'day' },
};
const rubrics = [discount, attempts];

function setup() {
  const store = new Store(':memory:');
  const agent = createAgent(
    { name: 'Retail', projectId: 'p', endpoints: [{ id: 'e', name: 'E' }], rubrics: { discount: true, jailbreak_attempt: true } },
    store, rubrics,
  );
  return { store, agent };
}

/** Stores one scored session for the agent with the given answers. */
function scored(store: Store, agentId: string, sessionId: string, startedAt: string, answers: Record<string, string>) {
  const runId = `run-${sessionId}`;
  store.saveRun({ id: runId, startedAt: new Date().toISOString(), projectId: 'p', projectName: 'P', endpointLabel: 'E',
    fromTs: 'a', toTs: 'b', sessions: 1, costUsd: 0, ms: 1, agentId });
  store.saveSession(
    { runId, sessionId, startedAt, endpointLabel: 'E', channel: 'rest', channelLabel: 'REST API', flowName: 'F', turns: 2,
      chunks: 1, rating: null, ratingComment: null, unscoreable: null, transcript: '[]', costUsd: 0, ms: 1, lastAt: startedAt },
    Object.entries(answers).map(([rubricId, raw]) => ({ runId, sessionId, rubricId, raw, confidence: null, chunks: 1, decidedBy: null })),
  );
}

const NOW = new Date('2026-09-23T12:00:00Z');

describe('windows', () => {
  it('keys a window on when the conversation happened, in UTC', () => {
    assert.equal(windowKey('day', 's1', '2026-09-22T23:30:00-02:00'), 'day:2026-09-23');
    assert.equal(windowKey('hour', 's1', '2026-09-22T10:59:59Z'), 'hour:2026-09-22T10');
    assert.equal(windowKey('session', 's1', '2026-09-22T10:00:00Z'), 'session:s1');
  });

  it('counts yes as a hit and no as none', () => {
    assert.equal(isHit('0.93'), true);
    assert.equal(isHit('0.5'), true);
    assert.equal(isHit('0.12'), false);
  });
});

describe('firing', () => {
  it('fires on the first occurrence for a threshold of one, once per session', () => {
    const { store, agent } = setup();
    scored(store, agent.id, 's1', '2026-09-23T11:00:00Z', { discount: '0.97' });
    scored(store, agent.id, 's2', '2026-09-23T11:10:00Z', { discount: '0.03' });
    const events = evaluateAlerts(agent, rubrics, store, NOW);
    assert.deepEqual(events.map((event) => [event.rubric.id, event.alert.sessions, event.fired]), [['discount', ['s1'], true]]);
    assert.deepEqual(evaluateAlerts(agent, rubrics, store, NOW), [], 'evaluating again fires nothing new');
    store.close();
  });

  it('waits for the threshold in a rate window, and fires when it is reached', () => {
    const { store, agent } = setup();
    for (let i = 0; i < 9; i++) scored(store, agent.id, `a${i}`, `2026-09-23T0${i}:00:00Z`, { jailbreak_attempt: '0.9' });
    assert.deepEqual(evaluateAlerts(agent, rubrics, store, NOW), [], 'nine is below ten');
    scored(store, agent.id, 'a9', '2026-09-23T09:30:00Z', { jailbreak_attempt: '0.9' });
    const [event] = evaluateAlerts(agent, rubrics, store, NOW);
    assert.equal(event.alert.windowKey, 'day:2026-09-23');
    assert.equal(event.alert.count, 10);
    assert.equal(event.alert.happenedAt, '2026-09-23T09:30:00Z', 'it happened when the tenth arrived');
    store.close();
  });

  it('does not trip a per-day alert with a catch-up batch spread over several days', () => {
    const { store, agent } = setup();
    // Four attempts on each of three days, all collected at once after a gap.
    for (const day of ['20', '21', '22']) {
      for (let i = 0; i < 4; i++) scored(store, agent.id, `d${day}-${i}`, `2026-09-${day}T1${i}:00:00Z`, { jailbreak_attempt: '0.9' });
    }
    assert.deepEqual(evaluateAlerts(agent, rubrics, store, NOW), [], 'twelve attempts, but never ten in one day');
    store.close();
  });

  it('raises the count on later hits without notifying again', () => {
    const { store, agent } = setup();
    for (let i = 0; i < 10; i++) scored(store, agent.id, `b${i}`, `2026-09-23T0${i % 10}:00:00Z`, { jailbreak_attempt: '0.9' });
    assert.equal(evaluateAlerts(agent, rubrics, store, NOW)[0].fired, true);
    scored(store, agent.id, 'b10', '2026-09-23T10:30:00Z', { jailbreak_attempt: '0.9' });
    const [update] = evaluateAlerts(agent, rubrics, store, NOW);
    assert.equal(update.fired, false);
    assert.equal(update.alert.count, 11);
    assert.equal(store.alerts({ agentId: agent.id })[0].count, 11);
    store.close();
  });

  it('marks an alert late when it is detected long after it happened', () => {
    const { store, agent } = setup();
    scored(store, agent.id, 'old', '2026-09-20T09:00:00Z', { discount: '0.9' });
    scored(store, agent.id, 'new', '2026-09-23T11:45:00Z', { discount: '0.9' });
    const events = evaluateAlerts(agent, rubrics, store, NOW);
    const late = Object.fromEntries(events.map((event) => [event.alert.sessions[0], event.late]));
    assert.deepEqual(late, { old: true, new: false });
    store.close();
  });

  it('ignores an alert rubric the agent has switched off', () => {
    const { store, agent } = setup();
    scored(store, agent.id, 's1', '2026-09-23T11:00:00Z', { discount: '0.97' });
    assert.deepEqual(evaluateAlerts({ ...agent, rubrics: { discount: false } }, rubrics, store, NOW), []);
    store.close();
  });
});

describe('delivery', () => {
  function recorder(fail?: { macos?: boolean; webhook?: boolean }) {
    const sent: { channel: string; args: unknown[] }[] = [];
    const notifier: Notifier = {
      async macos(...args) { if (fail?.macos) throw new Error('no display'); sent.push({ channel: 'macos', args }); },
      async webhook(...args) { if (fail?.webhook) throw new Error('webhook answered 500'); sent.push({ channel: 'webhook', args }); },
    };
    return { sent, notifier };
  }

  it('notifies the Mac and posts the webhook, and records both on the alert', async () => {
    const { store, agent } = setup();
    const withHook = { ...agent, alerts: { macos: true, webhookUrl: 'https://hooks.example.com/x' } };
    scored(store, agent.id, 's1', '2026-09-23T11:00:00Z', { discount: '0.97' });
    const [event] = evaluateAlerts(withHook, rubrics, store, NOW);
    const { sent, notifier } = recorder();
    const delivered = await deliverAlert(event.alert, event.rubric, withHook, event.late, store, notifier);
    assert.deepEqual(delivered, { macos: 'ok', webhook: 'ok' });
    assert.deepEqual(sent.map((item) => item.channel), ['macos', 'webhook']);
    const payload = sent[1].args[1] as Record<string, unknown>;
    assert.match(String(payload.text), /Retail.*Offered a discount/);
    assert.deepEqual(payload.sessions, ['s1']);
    assert.deepEqual(store.alerts()[0].delivered, { macos: 'ok', webhook: 'ok' });
    store.close();
  });

  it('records a failed delivery instead of throwing', async () => {
    const { store, agent } = setup();
    const withHook = { ...agent, alerts: { macos: true, webhookUrl: 'https://hooks.example.com/x' } };
    scored(store, agent.id, 's1', '2026-09-23T11:00:00Z', { discount: '0.97' });
    const [event] = evaluateAlerts(withHook, rubrics, store, NOW);
    const delivered = await deliverAlert(event.alert, event.rubric, withHook, false, store, recorder({ webhook: true }).notifier);
    assert.equal(delivered.macos, 'ok');
    assert.match(delivered.webhook, /error: webhook answered 500/);
    store.close();
  });

  it('says a late alert is late, with both times', () => {
    const { store, agent } = setup();
    const alert = { id: 1, agentId: agent.id, rubricId: 'discount', windowKey: 'session:s1', happenedAt: '2026-09-20T09:00:00Z',
      detectedAt: '2026-09-23T12:00:00Z', count: 1, sessions: ['s1abcdef99'], delivered: {} };
    assert.match(alertMessage(alert, discount, agent, true).message, /happened .* detected /);
    assert.doesNotMatch(alertMessage(alert, discount, agent, false).message, /detected/);
    store.close();
  });

  it('escapes quotes and backslashes for AppleScript', () => {
    assert.equal(appleScriptString('say "hi" \\ bye'), '"say \\"hi\\" \\\\ bye"');
  });
});
