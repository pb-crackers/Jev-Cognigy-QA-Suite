/**
 * Collection, scheduling and the background service, against the stub Jev API
 * and a fake OData feed. What matters here is the watermark: it must never skip
 * a session, and never re-read the world every tick.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { startStubApi, type StubApi } from './helpers/stub-api.ts';
import type { ConversationRecord, SessionSummary } from '../src/cognigy/odata.ts';
import type { Rubric } from '../src/rubrics/model.ts';
import type { Notifier } from '../src/alerts/deliver.ts';

let api: StubApi;
let collectAgent: typeof import('../src/collector/collect.ts').collectAgent;
let BATCH_LIMIT: number;
let Scheduler: typeof import('../src/collector/scheduler.ts').Scheduler;
let isDue: typeof import('../src/collector/scheduler.ts').isDue;
let buildPlist: typeof import('../src/collector/launchd.ts').buildPlist;
let Store: typeof import('../src/store/db.ts').Store;
let createAgent: typeof import('../src/agents/service.ts').createAgent;

const NOW = new Date('2026-09-23T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const discount: Rubric = {
  id: 'discount', name: 'Offered a discount', question: 'Did the agent offer a discount?', type: 'boolean',
  combine: 'any', weight: 0, enabled: true, invert: true, origin: 'custom', kind: 'alert', alert: { threshold: 1, window: 'session' },
};

/** A fake feed. Each session is two records; `masked` sessions are never sent to the model. */
function feed(sessions: { id: string; startedAt: string; lastAt: string; masked?: boolean }[], opts: { fail?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    odata: {
      async sessions(options: Record<string, unknown>): Promise<SessionSummary[]> {
        calls.push(options);
        if (opts.fail) throw new Error('OData 503');
        return sessions.slice(0, Number(options.limit)).map((s) => ({
          sessionId: s.id, startedAt: s.startedAt, lastAt: s.lastAt, endpointName: 'REST', channel: 'rest',
          rating: null, masked: Boolean(s.masked), records: 2,
        }));
      },
      async conversation(_projectId: string, sessionId: string): Promise<ConversationRecord[]> {
        const s = sessions.find((candidate) => candidate.id === sessionId)!;
        const record = (text: string, isUser: boolean, at: string): ConversationRecord => ({
          id: at, sessionId, inputId: 'i1', projectId: 'p', projectName: 'P', inputText: text, inputData: '{}',
          type: isUser ? 'input' : 'output', source: isUser ? 'user' : 'bot', timestamp: at, flowName: 'F',
          channel: 'rest', endpointName: 'REST', inHandoverRequest: false, inHandoverConversation: false,
          rating: null, ratingComment: null, isMasked: s.masked ? true : null,
        });
        return [record('I want 20% off', true, s.startedAt), record('Sure, 20% off applied.', false, s.lastAt)];
      },
    } as never,
  };
}

const cognigy = { async endpoints() { return [{ id: 'e', name: 'REST' }]; }, async flows() { return []; } };

function setup() {
  const store = new Store(':memory:');
  store.saveRubric(discount);
  const agent = createAgent({ name: 'Retail', projectId: 'p', endpoints: [{ id: 'e', name: 'REST' }] }, store, store.rubrics());
  return { store, agent };
}

function notifier() {
  const sent: string[] = [];
  const n: Notifier = { async macos(_t, subtitle) { sent.push(subtitle); }, async webhook() {} };
  return { sent, n };
}

before(async () => {
  api = await startStubApi({ r_discount: { type: 'noul', noul: 0.96 } });
  process.env.TYPESAFE_API_KEY = 'test-key-not-real';
  process.env.TYPESAFE_BASE_URL = api.baseURL;
  ({ collectAgent, BATCH_LIMIT } = await import('../src/collector/collect.ts'));
  ({ Scheduler, isDue } = await import('../src/collector/scheduler.ts'));
  ({ buildPlist } = await import('../src/collector/launchd.ts'));
  ({ Store } = await import('../src/store/db.ts'));
  ({ createAgent } = await import('../src/agents/service.ts'));
});
after(async () => {
  await api.close();
});

describe('collecting one agent', () => {
  it('looks back a day the first time, and moves the watermark to the settle line', async () => {
    const { store, agent } = setup();
    const { odata, calls } = feed([{ id: 's1', startedAt: minutesAgo(60), lastAt: minutesAgo(50) }]);
    const { n } = notifier();
    const report = await collectAgent(agent.id, { api: cognigy, odata, store, notifier: n }, NOW);

    assert.equal(calls[0].from, minutesAgo(24 * 60));
    assert.equal(calls[0].oldestFirst, true);
    assert.deepEqual(calls[0].endpointNames, ['REST']);
    assert.equal(report.scored, 1);
    assert.equal(report.watermark, minutesAgo(10));
    assert.equal(store.agentState(agent.id).watermark, minutesAgo(10));
    assert.equal(store.agentState(agent.id).lastError, null);
    store.close();
  });

  it('defers a conversation still going on, and scores it once it goes quiet', async () => {
    const { store, agent } = setup();
    const { n } = notifier();
    const live = feed([{ id: 's1', startedAt: minutesAgo(8), lastAt: minutesAgo(2) }]);
    const first = await collectAgent(agent.id, { api: cognigy, odata: live.odata, store, notifier: n }, NOW);
    assert.equal(first.scored, 0);
    assert.equal(first.deferred, 1);

    const later = new Date(NOW.getTime() + 30 * 60_000);
    const quiet = feed([{ id: 's1', startedAt: minutesAgo(8), lastAt: minutesAgo(2) }]);
    const second = await collectAgent(agent.id, { api: cognigy, odata: quiet.odata, store, notifier: n }, later);
    assert.equal(quiet.calls[0].from, first.watermark, 'picks up from where the last one stopped');
    assert.equal(second.scored, 1);
    store.close();
  });

  it('stops the watermark at the last session seen when a catch-up batch is full', async () => {
    const { store, agent } = setup();
    const many = Array.from({ length: BATCH_LIMIT + 50 }, (_, i) => ({
      id: `m${String(i).padStart(3, '0')}`, startedAt: new Date(Date.parse('2026-09-20T00:00:00Z') + i * 60_000).toISOString(),
      lastAt: new Date(Date.parse('2026-09-20T00:00:30Z') + i * 60_000).toISOString(), masked: true,
    }));
    store.saveAgentState({ agentId: agent.id, watermark: '2026-09-19T00:00:00.000Z', lastCollectedAt: null, lastError: null });
    const report = await collectAgent(agent.id, { api: cognigy, odata: feed(many).odata, store }, NOW);
    assert.equal(report.backlog, true);
    assert.equal(report.watermark, many[BATCH_LIMIT - 1].startedAt, 'not now: the rest have not been seen');
    store.close();
  });

  it('keeps the watermark where it was when a collection fails, and records why', async () => {
    const { store, agent } = setup();
    store.saveAgentState({ agentId: agent.id, watermark: '2026-09-23T09:00:00.000Z', lastCollectedAt: null, lastError: null });
    const report = await collectAgent(agent.id, { api: cognigy, odata: feed([], { fail: true }).odata, store }, NOW);
    assert.match(report.error!, /OData 503/);
    assert.equal(store.agentState(agent.id).watermark, '2026-09-23T09:00:00.000Z');
    assert.match(store.agentState(agent.id).lastError!, /OData 503/);
    store.close();
  });

  it('fires and delivers an alert in the same collection that scored it', async () => {
    const { store, agent } = setup();
    const { sent, n } = notifier();
    const report = await collectAgent(agent.id,
      { api: cognigy, odata: feed([{ id: 's1', startedAt: minutesAgo(40), lastAt: minutesAgo(30) }]).odata, store, notifier: n }, NOW);
    assert.equal(report.alertsFired, 1);
    assert.deepEqual(sent, ['Offered a discount']);
    assert.equal(store.alerts({ agentId: agent.id })[0].delivered.macos, 'ok');
    store.close();
  });
});

describe('scheduling', () => {
  const state = (lastCollectedAt: string | null) => ({ agentId: 'a', watermark: null, lastCollectedAt, lastError: null });

  it('is due when never collected, when the interval has passed, or with a backlog', () => {
    const { store, agent } = setup();
    assert.equal(isDue(agent, state(null), NOW, false), true);
    assert.equal(isDue(agent, state(minutesAgo(30)), NOW, false), false, 'hourly agent, 30 minutes ago');
    assert.equal(isDue(agent, state(minutesAgo(61)), NOW, false), true);
    assert.equal(isDue(agent, state(minutesAgo(1)), NOW, true), true, 'a backlog is due at once');
    assert.equal(isDue({ ...agent, enabled: false }, state(null), NOW, false), false);
    store.close();
  });

  it('collects due agents on a tick and leaves the rest alone', async () => {
    const { store, agent } = setup();
    const second = createAgent({ name: 'Paused', projectId: 'p', endpoints: [{ id: 'e2', name: 'OTHER' }], enabled: false }, store, []);
    const reports: string[] = [];
    const scheduler = new Scheduler(
      { api: cognigy, odata: feed([{ id: 's1', startedAt: minutesAgo(60), lastAt: minutesAgo(50) }]).odata, store, notifier: notifier().n },
      (report) => reports.push(report.agentId),
    );
    await scheduler.tick(NOW);
    assert.deepEqual(reports, [agent.id]);
    assert.ok(!reports.includes(second.id));
    await scheduler.tick(NOW);
    assert.deepEqual(reports, [agent.id], 'not due again within its interval');
    store.close();
  });

  it('runs a collect-now without overlapping a tick', async () => {
    const { store, agent } = setup();
    const scheduler = new Scheduler({ api: cognigy, odata: feed([]).odata, store });
    const [a, b] = await Promise.all([scheduler.tick(NOW), scheduler.collectNow(agent.id)]);
    assert.equal(a.length + 1, 2);
    assert.equal(b.agentId, agent.id);
    assert.equal(scheduler.busy, false);
    store.close();
  });
});

describe('the background service', () => {
  it('writes a LaunchAgent that starts at login, restarts on exit, and runs watch', () => {
    const plist = buildPlist({ node: '/usr/local/bin/node', cli: '/opt/app & co/bin/cli.ts', workingDirectory: '/opt/app',
      logDirectory: '/opt/app/logs', path: '/usr/bin' });
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(plist, /<string>watch<\/string>/);
    assert.match(plist, /\/opt\/app &amp; co\/bin\/cli\.ts/, 'paths are XML-escaped');
  });
});
