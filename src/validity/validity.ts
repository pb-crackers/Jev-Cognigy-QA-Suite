/**
 * Is a rubric measuring what it should?
 *
 * Not "was this verdict right" — a second Jev pass checking the first would be
 * circular. Instead, three things that can be checked without anyone labelling
 * conversations by hand:
 *
 * - **Lint.** Jev reads the rubric itself as state and answers: can it be
 *   answered from a transcript alone, does it ask one thing, would two careful
 *   reviewers agree, do its answer options separate cleanly — and, when the
 *   author stated one, does the wording detect what they said they need.
 * - **Behaviour.** From answers already stored, at no cost: how often it says
 *   yes, how confident it is, whether a quality rubric ever varies at all.
 * - **Stability.** A sample of scored sessions asked again with the identical
 *   state. Jev is not deterministic — four of nine rubrics were once seen to
 *   vary across byte-identical requests — and how often a verdict flips is a
 *   direct measure of how far its answers can be trusted.
 *
 *   validity = lint × (1 − flip rate) × (1 − ½ × low-confidence share)
 *
 * A rubric that has never been checked counts at half weight in health, so the
 * headline figure leans on rubrics that have been.
 */
import { noul } from '@typesafe-ai/sdk';
import type { Questions } from '@typesafe-ai/sdk';
import { ask } from '../jev.ts';
import { Ledger } from '../metering.ts';
import { normalize, type Rubric } from '../rubrics/model.ts';
import { reaskSession } from '../scoring/run.ts';
import { fixedState } from '../scoring/state.ts';
import { reconstruct } from '../traces/reconstruct.ts';
import { REVIEW_CONFIDENCE } from '../store/score.ts';
import type { Store } from '../store/db.ts';

/** The weight a rubric carries in health before anyone has checked it. */
export const UNCHECKED_VALIDITY = 0.5;
/** Fewer answers than this and behaviour says nothing either way. */
export const MIN_BEHAVIOUR_SAMPLE = 20;

export interface LintAnswers {
  observable: number;
  single: number;
  clear: number;
  separates: number;
  intent?: number;
}

export interface Behaviour {
  answers: number;
  /** Share of answers on the "yes" or top-half side. */
  positiveRate: number | null;
  meanConfidence: number | null;
  lowConfidenceShare: number;
}

export interface Stability {
  comparisons: number;
  flips: number;
  meanDelta: number;
}

export interface ValidityReport {
  rubricId: string;
  computedAt: string;
  lint: LintAnswers | null;
  lintScore: number | null;
  behaviour: Behaviour;
  stability: Stability | null;
  validity: number;
  warnings: string[];
}

const LINT_QUESTIONS: Record<keyof Omit<LintAnswers, 'intent'>, string> = {
  observable: 'Can this rubric be answered from a conversation transcript alone, without knowledge from outside it?',
  single: 'Does this rubric ask about exactly one thing, rather than combining several judgements into one answer?',
  clear: 'Would two careful reviewers reading the same conversation give this rubric the same answer?',
  separates: "Do this rubric's answer options separate the possible outcomes cleanly, without overlap or gaps?",
};

function describe(rubric: Rubric) {
  return {
    name: rubric.name,
    question: rubric.question,
    type: rubric.type,
    ...(rubric.trueMeans ? { yes_means: rubric.trueMeans } : {}),
    ...(rubric.falseMeans ? { no_means: rubric.falseMeans } : {}),
    ...(rubric.levels ? { levels: rubric.levels } : {}),
    ...(rubric.options ? { options: rubric.options } : {}),
  };
}

/**
 * One request per rubric, with that rubric alone as the state. Putting every
 * rubric in one state would be cheaper, but a question about "this rubric"
 * against twenty of them invites the answer to drift to the wrong one.
 */
export async function lintRubric(rubric: Rubric, ledger: Ledger): Promise<LintAnswers> {
  const questions: Questions = {};
  for (const [key, question] of Object.entries(LINT_QUESTIONS)) questions[key] = noul(question);
  if (rubric.intent) {
    questions.intent = noul({
      question: 'Does this rubric, as worded, detect what its author says they need?',
      author_needs: rubric.intent,
    });
  }
  const { answers } = await ask({
    stage: 'score', label: `lint ${rubric.id}`, state: { rubric: describe(rubric) }, questions, ledger, sessionId: 'validity',
  });
  const read = (key: string) => (answers as Record<string, { noul?: number }>)[key]?.noul ?? 0;
  return {
    observable: read('observable'), single: read('single'), clear: read('clear'), separates: read('separates'),
    ...(rubric.intent ? { intent: read('intent') } : {}),
  };
}

export function lintScore(lint: LintAnswers | null): number | null {
  if (!lint) return null;
  const parts = [lint.observable, lint.single, lint.clear, lint.separates, ...(lint.intent === undefined ? [] : [lint.intent])];
  return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

export function behaviourOf(rubric: Rubric, store: Pick<Store, 'resultsForRubric'>): Behaviour {
  const results = store.resultsForRubric(rubric.id);
  const confidences = results.map((result) => result.confidence).filter((value): value is number => value !== null);
  const positives = results.filter((result) => {
    if (rubric.type === 'boolean') return Number(result.raw) >= 0.5;
    const normalized = normalize(rubric, rubric.type === 'score' ? Number(result.raw) : result.raw);
    // "Positive" means the thing asked about is present, before any inversion.
    const direct = rubric.invert && normalized !== undefined ? 1 - normalized : normalized;
    return direct !== undefined && direct >= 0.5;
  }).length;
  return {
    answers: results.length,
    positiveRate: results.length ? positives / results.length : null,
    meanConfidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
    lowConfidenceShare: confidences.length
      ? confidences.filter((value) => value < REVIEW_CONFIDENCE).length / confidences.length
      : 0,
  };
}

/** Whether two answers to the same rubric disagree on the verdict. */
export function flipped(rubric: Rubric, a: number | string, b: number | string): boolean {
  if (rubric.type === 'boolean') return Number(a) >= 0.5 !== Number(b) >= 0.5;
  if (rubric.type === 'score') return Math.abs(Number(a) - Number(b)) >= 0.5;
  return String(a) !== String(b);
}

function delta(rubric: Rubric, a: number | string, b: number | string): number {
  if (rubric.type === 'choice') return String(a) === String(b) ? 0 : 1;
  const scale = rubric.type === 'score' ? Math.max(1, (rubric.levels?.length ?? 2) - 1) : 1;
  return Math.abs(Number(a) - Number(b)) / scale;
}

/**
 * Re-asks a sample of scored sessions, all their rubrics in one request each,
 * and compares every answer with the stored one.
 */
export async function measureStability(
  rubrics: Rubric[],
  store: Store,
  ledger: Ledger,
  sample = 5,
): Promise<Map<string, Stability>> {
  const byId = new Map(rubrics.map((rubric) => [rubric.id, rubric]));
  const tally = new Map<string, { comparisons: number; flips: number; deltaSum: number }>();

  for (const session of store.recentSessions(sample)) {
    const stored = store.latestResults([session.sessionId]).filter((result) => byId.has(result.rubricId));
    if (stored.length === 0) continue;
    const traces = session.agentId ? store.tracesFor(session.agentId, session.sessionId) : [];
    const fixed = session.traceCoverage && traces.length ? fixedState(reconstruct(traces)) : {};
    const again = await reaskSession(session, stored.map((result) => byId.get(result.rubricId)!), ledger, fixed);

    for (const result of stored) {
      const rubric = byId.get(result.rubricId)!;
      const fresh = again.get(rubric.id);
      if (!fresh) continue;
      const before = rubric.type === 'choice' ? result.raw : Number(result.raw);
      const entry = tally.get(rubric.id) ?? { comparisons: 0, flips: 0, deltaSum: 0 };
      entry.comparisons++;
      if (flipped(rubric, before, fresh.raw)) entry.flips++;
      entry.deltaSum += delta(rubric, before, fresh.raw);
      tally.set(rubric.id, entry);
    }
  }
  return new Map([...tally].map(([id, entry]) => [id, {
    comparisons: entry.comparisons, flips: entry.flips, meanDelta: entry.deltaSum / entry.comparisons,
  }]));
}

export function validityOf(
  rubric: Rubric,
  lint: LintAnswers | null,
  behaviour: Behaviour,
  stability: Stability | null,
): { validity: number; warnings: string[] } {
  const warnings: string[] = [];
  const base = lintScore(lint) ?? UNCHECKED_VALIDITY;
  const flipRate = stability && stability.comparisons ? stability.flips / stability.comparisons : 0;
  const validity = base * (1 - flipRate) * (1 - 0.5 * behaviour.lowConfidenceShare);

  if (lint) {
    if (lint.observable < 0.5) warnings.push('may not be answerable from the transcript alone');
    if (lint.single < 0.5) warnings.push('seems to ask more than one thing at once');
    if (lint.clear < 0.5) warnings.push('reviewers could reasonably disagree on it');
    if (lint.separates < 0.5) warnings.push('its answer options overlap or leave gaps');
    if (lint.intent !== undefined && lint.intent < 0.5) warnings.push('the wording may not catch what its intent says it should');
  }
  if (stability && flipRate >= 0.2) {
    warnings.push(`its verdict changed on ${stability.flips} of ${stability.comparisons} identical re-asks`);
  }
  if (behaviour.lowConfidenceShare >= 0.5 && behaviour.answers >= MIN_BEHAVIOUR_SAMPLE) {
    warnings.push('most of its answers are low-confidence');
  }
  // A rarely-firing alert is working as intended; a quality rubric that never
  // varies is measuring nothing.
  if (rubric.kind !== 'alert' && behaviour.answers >= MIN_BEHAVIOUR_SAMPLE && behaviour.positiveRate !== null &&
      (behaviour.positiveRate <= 0.02 || behaviour.positiveRate >= 0.98)) {
    warnings.push('gives the same answer almost every time, so it may not be telling conversations apart');
  }
  return { validity: Math.max(0, Math.min(1, validity)), warnings };
}

export async function checkValidity(
  store: Store,
  rubrics: Rubric[],
  options: { stability?: boolean; sample?: number; ledger?: Ledger } = {},
): Promise<{ reports: ValidityReport[]; ledger: Ledger }> {
  const ledger = options.ledger ?? new Ledger();
  const enabled = rubrics.filter((rubric) => rubric.enabled);
  const stability = options.stability ? await measureStability(enabled, store, ledger, options.sample) : new Map();
  const previous = store.validityReports<ValidityReport>();
  const computedAt = new Date().toISOString();
  const reports: ValidityReport[] = [];

  for (const rubric of enabled) {
    const lint = await lintRubric(rubric, ledger);
    const behaviour = behaviourOf(rubric, store);
    // A lint-only check keeps the stability measured last time rather than forgetting it.
    const measured = stability.get(rubric.id) ?? previous.get(rubric.id)?.stability ?? null;
    const { validity, warnings } = validityOf(rubric, lint, behaviour, measured);
    const report: ValidityReport = {
      rubricId: rubric.id, computedAt, lint, lintScore: lintScore(lint), behaviour, stability: measured, validity, warnings,
    };
    store.saveValidity(rubric.id, report, computedAt);
    reports.push(report);
  }
  return { reports, ledger };
}
