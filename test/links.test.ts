/**
 * Flow editor links, and the node attribution they carry into a briefing.
 * Pure; no network, no API key, no spend.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { appHostFrom, nodeResolver, nodeUrl, resolveNodes } from '../src/cognigy/links.ts';
import { buildBriefing } from '../src/briefing.ts';
import type { RunRow, SessionRow, ResultRow } from '../src/store/db.ts';
import type { Rubric } from '../src/rubrics/model.ts';

const PROJECT = '6a98358c39b9f4bad99e614f';
const LOCALE = '6a98358c39b9f4bad99e6151';
const FLOW_REF = '85a12742-f365-45d5-9387-449a0ec2be05';
const FLOW_ID = '6aad3c9512703c9f60c4dd8d';
const NODE = '6aad4cb6c9ced5e3143d146f';

describe('the Flow editor host', () => {
  it('drops the api- prefix, which is the whole rule', () => {
    assert.equal(appHostFrom('https://api-trial-us.cognigy.ai'), 'trial-us.cognigy.ai');
    assert.equal(appHostFrom('api-trial-us.cognigy.ai'), 'trial-us.cognigy.ai');
  });

  it('refuses to guess when the prefix is absent', () => {
    // A wrong host makes every link in the briefing a 404, which is worse than
    // no link at all — so an unrecognised base yields nothing.
    assert.equal(appHostFrom('https://app.cognigy.ai'), undefined);
    assert.equal(appHostFrom(''), undefined);
    assert.equal(appHostFrom(undefined), undefined);
  });
});

describe('the node URL', () => {
  it('reproduces a real editor URL exactly', () => {
    assert.equal(
      nodeUrl({ appHost: 'trial-us.cognigy.ai', projectId: PROJECT, localeId: LOCALE,
        flowId: FLOW_ID, nodeId: '6aad3c9ac9ced5e3143cfae8' }),
      `https://trial-us.cognigy.ai/project/${PROJECT}/${LOCALE}/flow/${FLOW_ID}/chart/6aad3c9ac9ced5e3143cfae8`,
    );
  });

  it('returns nothing unless every part is present', () => {
    const full = { appHost: 'h', projectId: 'p', localeId: 'l', flowId: 'f', nodeId: 'n' };
    for (const key of Object.keys(full) as (keyof typeof full)[]) {
      assert.equal(nodeUrl({ ...full, [key]: undefined }), undefined, `missing ${key}`);
    }
    assert.ok(nodeUrl(full));
  });
});

describe('the resolver', () => {
  const flows = new Map([[FLOW_REF, { id: FLOW_ID, name: 'API - JEV Inference' }]]);
  const base = { appHost: 'trial-us.cognigy.ai', projectId: PROJECT, localeId: LOCALE, flows };

  it('distinguishes two nodes that share a label', () => {
    // The reason this feature exists: four `say` nodes all report "Say".
    const nodes = nodeResolver({ ...base, flowsInRun: new Set([FLOW_REF]) });
    const a = { nodeLabel: 'Say', nodeType: 'say', nodeId: 'aaa', flowRef: FLOW_REF };
    const b = { nodeLabel: 'Say', nodeType: 'say', nodeId: 'bbb', flowRef: FLOW_REF };
    assert.equal(nodes.describe(a), nodes.describe(b));
    assert.notEqual(nodes.url(a), nodes.url(b));
  });

  it('names the Flow only when the run spans more than one', () => {
    const turn = { nodeLabel: 'Question', nodeType: 'question', nodeId: NODE, flowRef: FLOW_REF };
    const one = nodeResolver({ ...base, flowsInRun: new Set([FLOW_REF]) });
    const two = nodeResolver({ ...base, flowsInRun: new Set([FLOW_REF, 'other-ref']) });
    assert.equal(one.describe(turn), 'Question · question');
    assert.equal(two.describe(turn), 'Question · question · API - JEV Inference');
  });

  it('builds no URL for a Flow that no longer exists', () => {
    const nodes = nodeResolver({ ...base, flowsInRun: new Set(['deleted-ref']) });
    assert.equal(nodes.url({ nodeId: NODE, flowRef: 'deleted-ref' }), undefined);
  });
});

describe('resolveNodes', () => {
  const api = (counts: { projects: number; flows: number }) => ({
    async projects() { counts.projects++; return [{ id: PROJECT, localeId: LOCALE }]; },
    async flows() { counts.flows++; return [{ id: FLOW_ID, referenceId: FLOW_REF, name: 'F' }]; },
  });
  const transcripts = [
    JSON.stringify([{ role: 'agent', text: 'a', nodeId: NODE, flowRef: FLOW_REF }]),
    JSON.stringify([{ role: 'agent', text: 'b', nodeId: NODE, flowRef: FLOW_REF }]),
  ];

  it('calls the API once each, however many sessions there are', async () => {
    const counts = { projects: 0, flows: 0 };
    await resolveNodes({ api: api(counts), apiBase: 'https://api-x.cognigy.ai',
      appBase: undefined, projectId: PROJECT, transcripts });
    assert.deepEqual(counts, { projects: 1, flows: 1 });
  });

  it('does not call the API at all when no host can be resolved', async () => {
    const counts = { projects: 0, flows: 0 };
    const nodes = await resolveNodes({ api: api(counts), apiBase: 'https://app.cognigy.ai',
      appBase: undefined, projectId: PROJECT, transcripts });
    assert.deepEqual(counts, { projects: 0, flows: 0 });
    assert.equal(nodes.url({ nodeId: NODE, flowRef: FLOW_REF }), undefined);
  });

  it('prefers the configured override to the derived host', async () => {
    const counts = { projects: 0, flows: 0 };
    const nodes = await resolveNodes({ api: api(counts), apiBase: 'https://app.cognigy.ai',
      appBase: 'https://my-cognigy.example.com', projectId: PROJECT, transcripts });
    assert.match(nodes.url({ nodeId: NODE, flowRef: FLOW_REF }) ?? '', /^https:\/\/my-cognigy\.example\.com\//);
  });

  it('survives an unreachable Management API, losing the links and nothing else', async () => {
    const nodes = await resolveNodes({
      api: { async projects() { throw new Error('down'); }, async flows() { throw new Error('down'); } },
      apiBase: 'https://api-x.cognigy.ai', appBase: undefined, projectId: PROJECT, transcripts,
    });
    assert.equal(nodes.url({ nodeId: NODE, flowRef: FLOW_REF }), undefined);
  });

  it('ignores a transcript that will not parse', async () => {
    const counts = { projects: 0, flows: 0 };
    await resolveNodes({ api: api(counts), apiBase: 'https://api-x.cognigy.ai', appBase: undefined,
      projectId: PROJECT, transcripts: ['not json', ...transcripts] });
    assert.deepEqual(counts, { projects: 1, flows: 1 });
  });
});

describe('the briefing excerpt', () => {
  const rubric: Rubric = {
    id: 'helped', name: 'Helped', question: 'Was the customer helped?',
    type: 'boolean', combine: 'last', weight: 1, enabled: true,
  };
  const turns = [
    { role: 'user', text: 'hi' },
    { role: 'agent', text: 'How can I help you today?', nodeLabel: 'Question',
      nodeType: 'question', nodeId: NODE, flowRef: FLOW_REF },
    { role: 'system', text: '[call ended]' },
  ];
  const session = (over: Partial<SessionRow> = {}): SessionRow => ({
    runId: 'r', sessionId: 'sess1234', startedAt: '2026-09-21T10:00:00.000Z',
    endpointLabel: 'E', channel: 'rest', channelLabel: 'REST API', flowName: 'F',
    turns: turns.length, chunks: 1, rating: null, ratingComment: null, unscoreable: null,
    transcript: JSON.stringify(turns), costUsd: 0, ms: 1, ...over,
  });
  const run: RunRow = {
    id: 'r', startedAt: '2026-09-21T10:00:00.000Z', projectId: PROJECT, projectName: 'P',
    endpointLabel: 'Any endpoint', fromTs: '2026-09-01', toTs: '2026-09-21',
    sessions: 1, costUsd: 0, ms: 1,
  };
  // A failing result, so the rubric is quoted in "what to fix".
  const results: ResultRow[] = [
    { runId: 'r', sessionId: 'sess1234', rubricId: 'helped', raw: '0.02', confidence: null,
      chunks: 1, decidedBy: null },
  ];
  const nodes = nodeResolver({
    appHost: 'trial-us.cognigy.ai', projectId: PROJECT, localeId: LOCALE,
    flows: new Map([[FLOW_REF, { id: FLOW_ID, name: 'API - JEV Inference' }]]),
    flowsInRun: new Set([FLOW_REF]),
  });

  it('links the speaker label, not the words', () => {
    const md = buildBriefing(run, [session()], results, [rubric], nodes);
    assert.match(md, /\*\*\[Agent\]\(https:\/\/trial-us\.cognigy\.ai\/project\//);
    assert.match(md, /"Question · question"\):\*\* How can I help you today\?/);
  });

  it('leaves the quoted transcript byte-identical to an unlinked briefing', () => {
    // The excerpt is evidence an agent greps the Flow for. Stripping the link
    // markup must give back exactly what the briefing produces without nodes.
    const linked = buildBriefing(run, [session()], results, [rubric], nodes);
    const plain = buildBriefing(run, [session()], results, [rubric]);
    const stripped = linked.replace(/\[Agent\]\([^)]*\)/g, 'Agent');
    assert.equal(stripped, plain);
  });

  it('adds no line at all in the normal case', () => {
    const linked = buildBriefing(run, [session()], results, [rubric], nodes);
    const plain = buildBriefing(run, [session()], results, [rubric]);
    assert.equal(linked.split('\n').length, plain.split('\n').length);
  });

  it('falls back to a plain id line when no link can be built', () => {
    const unlinkable = nodeResolver({
      appHost: undefined, projectId: PROJECT, localeId: LOCALE,
      flows: new Map(), flowsInRun: new Set([FLOW_REF]),
    });
    const md = buildBriefing(run, [session()], results, [rubric], unlinkable);
    assert.match(md, new RegExp(`> ↳ node \`${NODE}\` · flow \`${FLOW_REF}\``));
    assert.ok(!md.includes('[Agent]'), 'no link is emitted');
  });

  it('says nothing for a run scored before node capture', () => {
    const old = session({
      transcript: JSON.stringify(turns.map(({ role, text }) => ({ role, text }))),
    });
    const md = buildBriefing(run, [old], results, [rubric], nodes);
    assert.ok(!md.includes('[Agent]'));
    assert.ok(!md.includes('↳ node'));
    assert.equal(md, buildBriefing(run, [old], results, [rubric]));
  });
});
