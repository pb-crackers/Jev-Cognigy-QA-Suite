/**
 * Turns a scoring run into a briefing a person or a coding agent can act on.
 *
 * The point is synthesis, not export. A dump of every session and every number
 * is not actionable; what someone fixing a Flow needs is which rubrics are
 * failing, what those rubrics actually measure, and a couple of real excerpts
 * showing the failure. So this leads with the ranked fix list and quotes
 * evidence underneath it.
 */
import type { Rubric } from './rubrics/model.ts';
import { normalize, scaleOf } from './rubrics/model.ts';
import type { ResultRow, RunRow, SessionRow } from './store/db.ts';
import { scoreSessions, REVIEW_CONFIDENCE, type ScoredSession } from './store/score.ts';

interface Turn {
  role: 'user' | 'agent' | 'system';
  text: string;
}

/** How many example sessions to quote per failing rubric. */
const EXAMPLES_PER_RUBRIC = 2;
/** Turns of context to quote around the end of a conversation. */
const EXCERPT_TURNS = 6;
/** A rubric scoring at or below this share of its range is worth reporting. */
const WEAK_THRESHOLD = 0.6;

interface RubricSummary {
  rubric: Rubric;
  /** Mean normalised contribution, 0-1, across scoreable sessions. */
  mean: number;
  scored: number;
  lowConfidence: number;
  /** Sessions where this rubric scored worst, worst first. */
  worst: ScoredSession[];
}

function excerpt(session: SessionRow): string {
  let turns: Turn[] = [];
  try {
    turns = JSON.parse(session.transcript) as Turn[];
  } catch {
    return '_(transcript unavailable)_';
  }
  // The end of a conversation is where outcome rubrics are decided, so the tail
  // is the part worth quoting.
  const tail = turns.slice(-EXCERPT_TURNS);
  const elided = turns.length > tail.length ? `_(…${turns.length - tail.length} earlier turns)_\n` : '';
  return (
    elided +
    tail
      .map((turn) => {
        if (turn.role === 'system') return `> _${turn.text}_`;
        return `> **${turn.role === 'user' ? 'Customer' : 'Agent'}:** ${turn.text}`;
      })
      .join('\n')
  );
}

function rawDisplay(rubric: Rubric, raw: number | string): string {
  if (rubric.type === 'boolean') return Number(raw) >= 0.5 ? 'yes' : 'no';
  if (rubric.type === 'score') {
    const scale = scaleOf(rubric);
    return `${Number(raw).toFixed(1)}${scale ? ` of ${scale}` : ''}`;
  }
  return String(raw);
}

function summarise(scored: ScoredSession[], rubrics: Rubric[]): RubricSummary[] {
  return rubrics
    .map((rubric) => {
      const values: { session: ScoredSession; normalized: number }[] = [];
      let lowConfidence = 0;

      for (const entry of scored) {
        const result = entry.results.get(rubric.id);
        if (!result) continue;
        if (result.lowConfidence) lowConfidence++;
        if (result.normalized !== undefined) {
          values.push({ session: entry, normalized: result.normalized });
        }
      }

      const mean = values.length
        ? values.reduce((sum, item) => sum + item.normalized, 0) / values.length
        : 1;

      return {
        rubric,
        mean,
        scored: values.length,
        lowConfidence,
        worst: values
          .sort((a, b) => a.normalized - b.normalized)
          .slice(0, EXAMPLES_PER_RUBRIC)
          .map((item) => item.session),
      };
    })
    .sort((a, b) => a.mean - b.mean);
}

export function buildBriefing(
  run: RunRow,
  sessions: SessionRow[],
  results: ResultRow[],
  rubrics: Rubric[],
): string {
  const scored = scoreSessions(sessions, results, rubrics);
  const scoreable = scored.filter((entry) => !entry.session.unscoreable);
  const summaries = summarise(scoreable, rubrics);
  const weak = summaries.filter((summary) => summary.mean < WEAK_THRESHOLD && summary.scored > 0);

  const composites = scoreable
    .map((entry) => entry.composite)
    .filter((value): value is number => value !== undefined);
  const average = composites.length
    ? composites.reduce((sum, value) => sum + value, 0) / composites.length
    : undefined;

  const lines: string[] = [];
  const push = (text = '') => lines.push(text);

  push(`# Conversation QA briefing — ${run.projectName}`);
  push();
  push(
    `${run.sessions} session(s) from ${run.fromTs.slice(0, 10)} to ${run.toTs.slice(0, 10)}` +
      `, endpoint: ${run.endpointLabel}. ` +
      (average !== undefined ? `Average overall score **${average.toFixed(1)} of 5**.` : ''),
  );
  push();
  push(
    'Scored automatically against the rubrics below. Each rubric is a single question put ' +
      'to a classifier, so a score reflects that question and nothing more.',
  );
  push();

  // ---- what to fix ----
  push('## What to fix, worst first');
  push();
  if (weak.length === 0) {
    push('Nothing scored below the reporting threshold across this batch.');
    push();
  } else {
    for (const summary of weak) {
      const { rubric } = summary;
      const percent = Math.round(summary.mean * 100);
      push(`### ${rubric.name} — scoring ${percent}% of the ideal`);
      push();
      push(`**What this measures:** ${rubric.question}`);
      if (rubric.type === 'boolean' && (rubric.trueMeans || rubric.falseMeans)) {
        if (rubric.trueMeans) push(`- A *yes* means: ${rubric.trueMeans}`);
        if (rubric.falseMeans) push(`- A *no* means: ${rubric.falseMeans}`);
      }
      if (rubric.type === 'score' && rubric.levels) {
        push(`- Levels: ${rubric.levels.map((level, index) => `${index} = ${level}`).join('; ')}`);
      }
      if (rubric.type === 'choice' && rubric.options) {
        push(
          `- Options: ${Object.entries(rubric.options)
            .map(([key, description]) => `\`${key}\` (${description})`)
            .join('; ')}`,
        );
      }
      if (rubric.invert) {
        push('- A high answer is the **bad** outcome for this rubric.');
      }
      if (summary.lowConfidence > 0) {
        push(
          `- ⚠ ${summary.lowConfidence} of ${summary.scored} scored sessions came back ` +
            'low-confidence, so treat this rubric\'s average as soft.',
        );
      }
      push();

      for (const entry of summary.worst) {
        const result = entry.results.get(rubric.id);
        push(
          `**Example — session \`${entry.session.sessionId.slice(0, 8)}\`** ` +
            `(${entry.session.turns} turns, this rubric: ` +
            `${result ? rawDisplay(rubric, result.raw) : 'n/a'}` +
            `${result?.confidence !== null && result?.confidence !== undefined ? `, confidence ${result.confidence.toFixed(2)}` : ''})`,
        );
        push();
        push(excerpt(entry.session));
        push();
      }
    }
  }

  // ---- everything measured ----
  push('## Every rubric in this run');
  push();
  push('| Rubric | Measures | Mean | Sessions | Low confidence |');
  push('| --- | --- | --- | --- | --- |');
  for (const summary of summaries) {
    push(
      `| ${summary.rubric.name} | ${summary.rubric.question} | ` +
        `${Math.round(summary.mean * 100)}% | ${summary.scored} | ${summary.lowConfidence} |`,
    );
  }
  push();

  // ---- caveats, stated rather than implied ----
  push('## How to read this');
  push();
  push(
    `- **Low confidence is not a bad score.** A result is flagged when the classifier's ` +
      `distribution was flat, which usually means the transcript did not contain enough ` +
      `to judge. Short test conversations flag often and legitimately. The threshold ` +
      `here is ${REVIEW_CONFIDENCE}.`,
  );
  push(
    '- **A rubric that is low-confidence almost everywhere is probably the problem, not ' +
      'the agent.** That usually means the question is too vague to answer consistently.',
  );
  const skipped = scored.length - scoreable.length;
  if (skipped > 0) {
    push(
      `- ${skipped} session(s) were not scoreable (masked by PII redaction, or containing ` +
        'no conversation) and are excluded from every average above.',
    );
  }
  push(
    '- Weights affect only the overall score, not the per-rubric means in this briefing.',
  );
  push();
  push(
    `_Run ${run.id} · ${run.sessions} sessions · $${run.costUsd.toFixed(6)} · ` +
      `${(run.ms / 1000).toFixed(1)}s._`,
  );

  return lines.join('\n');
}
