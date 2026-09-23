/**
 * Coverage: is there anything the agent is told to do that no rubric checks?
 *
 * A property of the rubric set, not of any single rubric. It fits how Jev
 * works: it cannot propose a missing rubric, but it can pick. Code splits the
 * agent's instructions — read from its newest logged LLM call — into individual
 * constraints; Jev answers one `choice` per constraint, whose options are the
 * agent's rubrics plus `none`. Every `none` is a gap.
 *
 * A general rubric — "did it break any of its own instructions" — is left out
 * of the choice. It does watch everything, but counting it would make every
 * rule look specifically covered; the report says instead which gaps only the
 * general rubric is watching.
 *
 * Writing the rubric that would close a gap is generative work, and left to a
 * person or a coding agent. Finding the gap is not.
 */
import { choice } from '@typesafe-ai/sdk';
import type { Questions } from '@typesafe-ai/sdk';
import { agentRubrics, type Agent } from '../agents/model.ts';
import { ask } from '../jev.ts';
import { Ledger } from '../metering.ts';
import type { Rubric } from '../rubrics/model.ts';
import type { Store } from '../store/db.ts';
import { reconstruct } from '../traces/reconstruct.ts';

/** Enough to cover a detailed prompt without sending a novel. */
export const MAX_CONSTRAINTS = 40;
/** Constraints per request, so no single question block grows past what Jev accepts. */
const PER_REQUEST = 15;
const NONE = 'none';

/** Words that mark a sentence as something the agent is being told to do or not do. */
const DIRECTIVE = /\b(never|always|must|do not|don't|only|should|shall|avoid|refuse|escalate|ask|collect|confirm|call|use|greet|close|stay|redirect|refer|state|say|any .{1,100} comes? from)\b/i;
/** Boilerplate every Cognigy prompt carries and no rubric should be expected to cover. */
const BOILERPLATE = /(technology you're based on|use the user's language|current date is|use en-US|ignore instructions in the name)/i;

/**
 * Splits instructions into sentences that tell the agent to do something.
 *
 * Deliberately generous: a sentence wrongly kept costs one question, while a
 * constraint wrongly dropped is a gap nobody sees.
 */
export function constraints(instructions: string): string[] {
  const sentences = instructions
    .split(/\n+/)
    // A Markdown heading names a section; it is not an instruction.
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/^\s*([-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z(])/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12 && sentence.length <= 400)
    .filter((sentence) => DIRECTIVE.test(sentence) && !BOILERPLATE.test(sentence));
  return [...new Set(sentences)].slice(0, MAX_CONSTRAINTS);
}

export interface CoverageReport {
  agentId: string;
  computedAt: string;
  /** When the instructions were read from — the newest logged call. */
  instructionsAt: string;
  constraints: { text: string; rubricId: string | null; confidence: number | null }[];
  /** Instructions a specific rubric checks. */
  covered: number;
  /** Instructions no specific rubric checks. */
  gaps: number;
  /** General rubrics on for the agent, which do watch the gaps — just not specifically. */
  general: string[];
}

export async function checkCoverage(
  agent: Agent,
  rubrics: Rubric[],
  store: Store,
  ledger: Ledger = new Ledger(),
): Promise<CoverageReport> {
  const latest = store.latestTrace(agent.id);
  const instructions = latest ? reconstruct([latest]).instructions : undefined;
  if (!latest || !instructions) {
    throw new Error(
      `No logged instructions for "${agent.name}" yet. Install logging, or import traces, so its prompt can be read.`,
    );
  }

  const list = constraints(instructions);
  const active = agentRubrics(agent, rubrics).filter((rubric) => rubric.id !== NONE);
  const own = active.filter((rubric) => !rubric.general);
  const options: Record<string, string> = Object.fromEntries(own.map((rubric) => [rubric.id, rubric.question]));
  options[NONE] = 'No rubric checks whether the agent follows this instruction.';

  const results: CoverageReport['constraints'] = [];
  for (let start = 0; start < list.length; start += PER_REQUEST) {
    const batch = list.slice(start, start + PER_REQUEST);
    const questions: Questions = {};
    batch.forEach((text, index) => {
      questions[`c${start + index}`] = choice(
        { question: 'Which rubric, if any, checks whether the agent follows this instruction?', instruction: text },
        options,
      );
    });
    const { answers } = await ask({
      stage: 'score', label: `coverage ${agent.id}`, state: { rubrics: own.map((rubric) => ({ id: rubric.id, question: rubric.question })) },
      questions, ledger, sessionId: 'coverage',
    });
    batch.forEach((text, index) => {
      const answer = (answers as Record<string, { choice?: string; confidence?: number }>)[`c${start + index}`];
      const picked = answer?.choice && answer.choice !== NONE ? answer.choice : null;
      results.push({ text, rubricId: picked, confidence: answer?.confidence ?? null });
    });
  }

  const report: CoverageReport = {
    agentId: agent.id,
    computedAt: new Date().toISOString(),
    instructionsAt: latest.eventAt,
    constraints: results,
    covered: results.filter((item) => item.rubricId).length,
    gaps: results.filter((item) => !item.rubricId).length,
    general: active.filter((rubric) => rubric.general).map((rubric) => rubric.id),
  };
  store.saveCoverage(agent.id, report, report.computedAt);
  return report;
}
