/**
 * HTTP layer. Thin by design: it validates input, delegates, and serialises.
 *
 * A scoring run streams progress over server-sent events, because a batch takes
 * as long as Cognigy's rate limits allow and a progress bar that moves is worth
 * more than a faster-looking request that blocks.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as normalizePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CognigyApi } from './cognigy/api.ts';
import { OdataClient } from './cognigy/odata.ts';
import { INTERACTION_PANEL } from './cognigy/transcript.ts';
import { llmEquivalents } from './metering.ts';
import { DEFAULT_RUBRICS } from './rubrics/defaults.ts';
import { inferCombine, watchFieldProblems, type Rubric } from './rubrics/model.ts';
import { LIBRARY_IDS, LIBRARY_RUBRICS } from './rubrics/library.ts';
import { labelFor, type Modality } from './cognigy/channels.ts';
import { executeRun, type RunProgress } from './scoring/run.ts';
import { Store } from './store/db.ts';
import { scoreSessions } from './store/score.ts';
import { buildBriefing } from './briefing.ts';
import { handleWatchRoute, isLocalRequest, type WatchDeps } from './watch-routes.ts';
import type { Scheduler } from './collector/scheduler.ts';
import { resolveNodes } from './cognigy/links.ts';
import { fromEnv, missingKeys, type Config } from './config.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

interface Deps {
  config: Config;
  api: CognigyApi;
  odata: OdataClient;
  store: Store;
  /** The collector loop, when this process is the monitor. */
  scheduler?: Scheduler;
  demo?: boolean;
  feed?: WatchDeps['feed'];
}

async function readJson<T>(stream: AsyncIterable<Buffer>): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

function isRubric(value: unknown): value is Rubric {
  const rubric = value as Partial<Rubric>;
  return (
    typeof rubric?.name === 'string' &&
    typeof rubric.question === 'string' &&
    ['boolean', 'score', 'choice'].includes(rubric.type as string)
  );
}

/** A modality scope, or undefined for "every conversation". */
function asModality(value: unknown): Modality | undefined {
  return value === 'voice' || value === 'text' ? value : undefined;
}

/**
 * Modality notes, keeping only non-empty strings. An empty box in the editor
 * means no note, not an empty one, and a note kept for a modality the rubric
 * never runs on would be dead weight in the stored rubric.
 */
function asNotes(value: unknown, scope: Modality | undefined): Rubric['notes'] {
  const source = (value ?? {}) as Partial<Record<Modality, unknown>>;
  const notes: Partial<Record<Modality, string>> = {};
  for (const modality of ['voice', 'text'] as const) {
    if (scope && scope !== modality) continue;
    const note = source[modality];
    if (typeof note === 'string' && note.trim()) notes[modality] = note.trim();
  }
  return Object.keys(notes).length > 0 ? notes : undefined;
}

export function createApp(deps: Deps) {
  const { api, odata, store, config } = deps;
  const publicDir = join(import.meta.dirname, 'public');

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    // Through a tunnel, only the webhook is reachable. It is the one route that
    // authenticates, and the only one Cognigy needs.
    if (!url.pathname.startsWith('/hook/') && !isLocalRequest(request.headers)) {
      return send(403, { error: 'Only the webhook is reachable from outside this machine.' });
    }

    try {
      if (url.pathname === '/api/config') {
        return send(200, {
          projectId: config.projectId ?? null,
          apiBase: config.cognigyApiBase,
          odataBase: config.cognigyOdataBase,
          interactionPanelLabel: INTERACTION_PANEL,
        });
      }

      if (url.pathname === '/api/projects') {
        return send(200, await api.projects());
      }

      if (url.pathname === '/api/endpoints') {
        const projectId = url.searchParams.get('projectId');
        if (!projectId) return send(400, { error: 'projectId is required' });
        return send(200, await api.endpoints(projectId));
      }

      if (url.pathname === '/api/rubrics') {
        if (request.method === 'GET') return send(200, store.rubrics());

        if (request.method === 'POST') {
          const body = await readJson<Partial<Rubric>>(request);
          if (!isRubric(body)) return send(400, { error: 'Not a valid rubric' });
          const appliesTo = asModality(body.appliesTo);
          const id = body.id?.trim() || randomUUID().slice(0, 8);
          const stored = store.rubrics().find((candidate) => candidate.id === id);
          const kind = body.kind === 'alert' ? 'alert' : 'quality';
          const rubric: Rubric = {
            ...body,
            id,
            weight: Number(body.weight ?? 1),
            enabled: body.enabled !== false,
            appliesTo,
            notes: asNotes(body.notes, appliesTo),
            // Origin is a fact about where the rubric came from, never an input.
            origin: stored?.origin ?? (LIBRARY_IDS.has(id) ? 'library' : 'custom'),
            kind,
            alert: kind === 'alert' && body.alert
              ? { threshold: Math.max(1, Math.round(Number(body.alert.threshold) || 1)), window: body.alert.window }
              : undefined,
            intent: body.intent?.trim() || undefined,
            requiresTrace: body.requiresTrace === true || undefined,
            general: body.general === true || undefined,
            // Kept even when "agent", so a shipped default is never re-applied over a choice.
            about: body.about === 'customer' || body.about === 'agent' ? body.about : undefined,
            // Derived from the rubric's own shape rather than asked for.
            combine: inferCombine(body as Rubric),
          } as Rubric;
          const problems = watchFieldProblems(rubric);
          if (problems.length) return send(400, { error: problems.join('; ') });
          store.saveRubric(rubric);
          return send(200, rubric);
        }
      }

      const rubricMatch = url.pathname.match(/^\/api\/rubrics\/([\w-]+)$/);
      if (rubricMatch && request.method === 'DELETE') {
        store.deleteRubric(rubricMatch[1]);
        return send(200, { deleted: rubricMatch[1] });
      }

      if (url.pathname === '/api/preview' && request.method === 'POST') {
        const body = await readJson<{
          projectId: string; from: string; to: string;
          endpointName?: string | null; channels?: string[];
          limit?: number; skipScored?: boolean;
        }>(request);
        if (!body.projectId) return send(400, { error: 'projectId is required' });

        // Counted unfiltered, so the breakdown can offer every channel present —
        // including the ones currently switched off. Listing sessions costs
        // nothing; it is fetching and scoring them that does.
        const all = await odata.sessions({
          projectId: body.projectId,
          from: body.from,
          to: body.to,
          endpointName: body.endpointName,
          limit: body.limit ?? 100,
        });

        const byLabel = new Map<string, {
          label: string; kind: string; known: boolean; raws: Set<string>; sessions: number;
        }>();
        for (const session of all) {
          const resolved = labelFor(session.channel);
          const entry = byLabel.get(resolved.label) ?? {
            label: resolved.label, kind: resolved.kind, known: resolved.known,
            raws: new Set<string>(), sessions: 0,
          };
          entry.raws.add(resolved.raw);
          entry.sessions++;
          byLabel.set(resolved.label, entry);
        }

        const selected = body.channels;
        const included = selected
          ? all.filter((session) => selected.includes(labelFor(session.channel).raw))
          : all;

        const seen = body.skipScored ? store.alreadyScored(body.projectId) : new Set<string>();
        const fresh = included.filter((session) => !seen.has(session.sessionId));

        return send(200, {
          matched: included.length,
          excludedByChannel: all.length - included.length,
          alreadyScored: included.length - fresh.length,
          toScore: fresh.length,
          masked: included.filter((session) => session.masked).length,
          records: included.reduce((sum, session) => sum + session.records, 0),
          byChannel: [...byLabel.values()]
            .map((entry) => ({ ...entry, raws: [...entry.raws] }))
            .sort((a, b) => b.sessions - a.sessions),
        });
      }

      if (url.pathname === '/api/run' && request.method === 'POST') {
        const body = await readJson<{
          projectId: string; projectName: string; from: string; to: string;
          endpointName?: string | null; channels?: string[];
          limit?: number; skipScored?: boolean;
        }>(request);
        if (!body.projectId) return send(400, { error: 'projectId is required' });

        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const event = (name: string, data: unknown) =>
          response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

        try {
          const { run } = await executeRun(
            {
              projectId: body.projectId,
              projectName: body.projectName,
              from: body.from,
              to: body.to,
              endpointName: body.endpointName,
              channels: body.channels,
              limit: body.limit ?? 100,
              skipScored: body.skipScored !== false,
            },
            { odata, store, rubrics: store.rubrics() },
            (progress: RunProgress) => event('progress', progress),
          );
          event('done', run);
        } catch (error) {
          event('failed', { error: String(error) });
        }
        return response.end();
      }

      if (url.pathname === '/api/runs') {
        return send(200, store.runs());
      }

      const briefMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/briefing$/);
      if (briefMatch) {
        const runId = briefMatch[1];
        const run = store.runs().find((candidate) => candidate.id === runId);
        if (!run) return send(404, { error: 'No such run' });
        const sessions = store.sessionsForRun(runId);
        const nodes = await resolveNodes({
          api,
          apiBase: config.cognigyApiBase,
          appBase: config.cognigyAppBase,
          projectId: run.projectId,
          transcripts: sessions.map((session) => session.transcript),
        });
        const markdown = buildBriefing(
          run,
          sessions,
          store.resultsForRun(runId),
          store.rubrics(),
          nodes,
        );
        response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        return response.end(markdown);
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
      if (runMatch) {
        const runId = runMatch[1];
        const rubrics = store.rubrics();
        const scored = scoreSessions(
          store.sessionsForRun(runId),
          store.resultsForRun(runId),
          rubrics,
        );
        const run = store.runs().find((candidate) => candidate.id === runId);
        if (!run) return send(404, { error: 'No such run' });

        return send(200, {
          run,
          rubrics,
          comparison: llmEquivalents(Math.round(run.costUsd / 0.042e-6)),
          sessions: scored.map((entry) => ({
            ...entry.session,
            // Derived here rather than stored, so changing a rubric's scope
            // re-derives which rubrics did not apply without a re-score.
            channelKind: labelFor(entry.session.channel).kind,
            // The transcript is parsed client-side; contactId is never included.
            composite: entry.composite ?? null,
            flagged: entry.flagged,
            results: Object.fromEntries(entry.results),
          })),
        });
      }

      if (await handleWatchRoute(request, response, url, deps, send)) return;
      if (url.pathname.startsWith('/api/')) return send(404, { error: 'No such endpoint' });

      // Static files, path-traversal guarded.
      const requested = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = join(publicDir, normalizePath(requested));
      if (!filePath.startsWith(publicDir)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const file = await readFile(filePath);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      });
      response.end(file);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        response.writeHead(404).end('Not found');
        return;
      }
      console.error('[request]', url.pathname, error);
      if (!response.headersSent) send(502, { error: String(error) });
      else response.end();
    }
  });
}

export function buildDeps(): Deps {
  const partial = fromEnv();
  const missing = missingKeys(partial);
  if (missing.length > 0) {
    throw new Error(
      `Missing configuration: ${missing.join(', ')}. Run \`npx jev-cognigy-qa init\`.`,
    );
  }
  const config = partial as Config;
  const store = new Store();
  store.seedRubrics(DEFAULT_RUBRICS);
  store.seedLibrary(LIBRARY_RUBRICS, [...DEFAULT_RUBRICS.map((rubric) => rubric.id), ...LIBRARY_IDS]);
  store.fillShippedFields([...DEFAULT_RUBRICS, ...LIBRARY_RUBRICS], ['about']);

  return {
    config,
    store,
    api: new CognigyApi(config.cognigyApiBase, config.cognigyApiKey),
    odata: new OdataClient(config.cognigyOdataBase, config.cognigyApiKey),
  };
}
