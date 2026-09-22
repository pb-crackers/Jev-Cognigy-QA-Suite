/**
 * Machine-readable entry points, so a coding agent can drive the whole tool.
 *
 * Everything the browser UI does is available here with JSON in and JSON out:
 * list and write rubrics, score a date range, and read results back. That makes
 * the natural workflow "talk to an agent about what you want to measure, let it
 * write the rubrics and run the batch, then have it summarise the findings".
 *
 * These functions print nothing; the CLI owns output formatting.
 */
import { inferCombine, type Rubric } from './rubrics/model.ts';
import { scoreSessions } from './store/score.ts';
import { executeRun, type RunProgress } from './scoring/run.ts';
import type { CognigyApi } from './cognigy/api.ts';
import type { OdataClient } from './cognigy/odata.ts';
import type { Store } from './store/db.ts';
import { llmEquivalents } from './metering.ts';
import { buildBriefing } from './briefing.ts';
import { resolveNodes } from './cognigy/links.ts';
import type { Config } from './config.ts';

export interface HeadlessDeps {
  api: CognigyApi;
  odata: OdataClient;
  store: Store;
  /** Only the briefing needs this, to work out the Flow editor host. */
  config?: Pick<Config, 'cognigyApiBase' | 'cognigyAppBase'>;
}

export interface ScoreOptions {
  project: string;
  from: string;
  to: string;
  /** Endpoint name, "interaction-panel" for no endpoint, or omitted for any. */
  endpoint?: string;
  /** Raw channel values to include; omitted means every channel. */
  channels?: string[];
  limit: number;
  skipScored: boolean;
}

/** Resolves a project by id or by (case-insensitive) name fragment. */
export async function resolveProject(
  api: CognigyApi,
  needle: string,
): Promise<{ id: string; name: string }> {
  const projects = await api.projects();
  const byId = projects.find((project) => project.id === needle);
  if (byId) return byId;

  const lowered = needle.toLowerCase();
  const matches = projects.filter((project) => project.name.toLowerCase().includes(lowered));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `No project matches "${needle}". Available: ${projects.map((p) => p.name).join(', ')}`,
    );
  }
  throw new Error(
    `"${needle}" matches several projects: ${matches.map((p) => p.name).join(', ')}`,
  );
}

export interface ScoreReport {
  runId: string;
  project: string;
  endpoint: string;
  from: string;
  to: string;
  sessions: number;
  skipped: number;
  flagged: number;
  costUsd: number;
  ms: number;
  /** What the same token volume would have cost on a generative model. */
  comparison: { model: string; uncachedUsd: number; cachedUsd: number }[];
  rubrics: { id: string; name: string; type: string; combine: string; weight: number }[];
  results: ScoredSessionReport[];
}

export interface ScoredSessionReport {
  sessionId: string;
  startedAt: string;
  endpoint: string;
  turns: number;
  chunks: number;
  composite: number | null;
  unscoreable: string | null;
  rating: number | null;
  flagged: string[];
  scores: Record<string, { raw: number | string; confidence: number | null }>;
}

export async function score(
  options: ScoreOptions,
  deps: HeadlessDeps,
  onProgress?: (progress: RunProgress) => void,
): Promise<ScoreReport> {
  const project = await resolveProject(deps.api, options.project);
  const endpointName =
    options.endpoint === undefined
      ? undefined
      : options.endpoint === 'interaction-panel'
        ? null
        : options.endpoint;

  const { run, ledger } = await executeRun(
    {
      projectId: project.id,
      projectName: project.name,
      endpointName,
      channels: options.channels,
      from: options.from,
      to: options.to,
      limit: options.limit,
      skipScored: options.skipScored,
    },
    { odata: deps.odata, store: deps.store, rubrics: deps.store.rubrics() },
    onProgress,
  );

  return buildReport(run.id, deps, ledger.totals().inputTokens);
}

export function buildReport(
  runId: string,
  deps: HeadlessDeps,
  inputTokens?: number,
): ScoreReport {
  const run = deps.store.runs().find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`No run with id ${runId}`);

  const rubrics = deps.store.rubrics();
  const scored = scoreSessions(
    deps.store.sessionsForRun(runId),
    deps.store.resultsForRun(runId),
    rubrics,
  );

  const results: ScoredSessionReport[] = scored.map((entry) => ({
    sessionId: entry.session.sessionId,
    startedAt: entry.session.startedAt,
    endpoint: entry.session.endpointLabel,
    turns: entry.session.turns,
    chunks: entry.session.chunks,
    composite: entry.composite ?? null,
    unscoreable: entry.session.unscoreable,
    rating: entry.session.rating,
    flagged: entry.flagged,
    scores: Object.fromEntries(
      [...entry.results].map(([id, result]) => [
        id,
        { raw: result.raw, confidence: result.confidence },
      ]),
    ),
  }));

  return {
    runId,
    project: run.projectName,
    endpoint: run.endpointLabel,
    from: run.fromTs,
    to: run.toTs,
    sessions: run.sessions,
    skipped: results.filter((result) => result.unscoreable).length,
    flagged: results.filter((result) => result.flagged.length > 0).length,
    costUsd: run.costUsd,
    ms: run.ms,
    comparison: llmEquivalents(inputTokens ?? 0).map((estimate) => ({
      model: estimate.label,
      uncachedUsd: estimate.uncachedUsd,
      cachedUsd: estimate.cachedUsd,
    })),
    rubrics: rubrics.map((rubric) => ({
      id: rubric.id,
      name: rubric.name,
      type: rubric.type,
      combine: rubric.combine,
      weight: rubric.weight,
    })),
    results,
  };
}

/**
 * Validates a rubric written by hand or by an agent, returning the reasons it
 * is unusable rather than throwing on the first one.
 */
export function validateRubric(value: unknown): string[] {
  const problems: string[] = [];
  const rubric = value as Partial<Rubric>;

  if (!rubric || typeof rubric !== 'object') return ['not an object'];
  if (!rubric.name?.trim()) problems.push('name is required');
  if (!rubric.question?.trim()) problems.push('question is required');
  if (!['boolean', 'score', 'choice'].includes(rubric.type as string)) {
    problems.push('type must be boolean, score or choice');
  }
  if (rubric.combine !== undefined && !['any', 'last', 'mean'].includes(rubric.combine as string)) {
    problems.push('combine, if given, must be any, last or mean');
  }
  if (rubric.type === 'score' && (rubric.levels?.length ?? 0) < 2) {
    problems.push('a score rubric needs at least two levels, lowest first');
  }
  if (rubric.type === 'choice' && Object.keys(rubric.options ?? {}).length < 2) {
    problems.push('a choice rubric needs at least two options');
  }
  if (rubric.appliesTo !== undefined && !['voice', 'text'].includes(rubric.appliesTo)) {
    problems.push('appliesTo, if given, must be voice or text');
  }
  if (rubric.notes !== undefined) {
    const stray = Object.keys(rubric.notes).filter((key) => key !== 'voice' && key !== 'text');
    if (stray.length > 0) problems.push(`notes may only be voice or text, not: ${stray.join(', ')}`);
    // A note for a modality the rubric is scoped away from would never be sent,
    // which is worth saying rather than silently dropping.
    if (rubric.appliesTo && rubric.notes[rubric.appliesTo === 'voice' ? 'text' : 'voice']) {
      problems.push(`a rubric scoped to ${rubric.appliesTo} cannot carry a note for the other modality`);
    }
  }
  if (rubric.type === 'choice' && rubric.options) {
    const missing = Object.keys(rubric.options).filter(
      (key) => rubric.optionScores?.[key] === undefined,
    );
    if (missing.length > 0) {
      problems.push(`optionScores is missing a 0-1 goodness for: ${missing.join(', ')}`);
    }
  }
  return problems;
}

/** The same synthesis the UI offers, for piping to an agent or a file. */
export async function briefing(runId: string, deps: HeadlessDeps): Promise<string> {
  const run = deps.store.runs().find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`No run with id ${runId}`);
  const sessions = deps.store.sessionsForRun(runId);
  const nodes = await resolveNodes({
    api: deps.api,
    apiBase: deps.config?.cognigyApiBase,
    appBase: deps.config?.cognigyAppBase,
    projectId: run.projectId,
    transcripts: sessions.map((session) => session.transcript),
  });
  return buildBriefing(run, sessions, deps.store.resultsForRun(runId), deps.store.rubrics(), nodes);
}

/** Fills in what the tool derives, so callers only supply what they mean. */
export function completeRubric(candidate: Rubric): Rubric {
  return { ...candidate, combine: candidate.combine ?? inferCombine(candidate) };
}
