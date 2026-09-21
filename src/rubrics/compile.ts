/**
 * Compiles rubrics into Jev questions.
 *
 * Every rubric in a run goes into one request, because Jev reads the state once
 * and answers all questions against it in parallel — twenty rubrics cost the
 * same round trip as one.
 *
 * Questions are compiled per transcript rather than per run, which is what makes
 * modality scoping free: a voice-only rubric is simply absent from the questions
 * sent for a text conversation, and a modality note is folded into the
 * instructions of the sessions it applies to.
 */
import { choice, noul, score } from '@typesafe-ai/sdk';
import type { EntryType, Questions } from '@typesafe-ai/sdk';
import type { Modality } from '../cognigy/channels.ts';
import { applies, type Rubric } from './model.ts';

/** Question id for a rubric, kept stable so answers can be matched back. */
export function questionId(rubric: Rubric): string {
  return `r_${rubric.id}`;
}

/**
 * The instruction block for a rubric. All three question types take the same
 * object form, so the modality note has one home rather than three.
 */
function instructionsFor(rubric: Rubric, modality: Modality | undefined): EntryType {
  const note = modality ? rubric.notes?.[modality]?.trim() : undefined;
  return {
    question: rubric.question,
    focus: 'Judge only this question, against the conversation as given.',
    ...(note ? { note } : {}),
  };
}

/** The rubrics that apply to a conversation of this modality, in order. */
export function applicable(rubrics: Rubric[], modality: Modality | undefined): Rubric[] {
  return rubrics.filter((rubric) => applies(rubric, modality));
}

export function compile(rubrics: Rubric[], modality?: Modality): Questions {
  const questions: Questions = {};

  for (const rubric of applicable(rubrics, modality)) {
    const id = questionId(rubric);
    const instructions = instructionsFor(rubric, modality);

    if (rubric.type === 'boolean') {
      // Criteria are optional, and worth omitting rather than filling with a
      // restatement of the question when the author has not written them.
      questions[id] =
        rubric.trueMeans || rubric.falseMeans
          ? noul(instructions, {
              true: rubric.trueMeans ?? 'The statement holds.',
              false: rubric.falseMeans ?? 'The statement does not hold.',
            })
          : noul(instructions);
      continue;
    }

    if (rubric.type === 'score') {
      const levels = rubric.levels ?? [];
      if (levels.length < 2) {
        throw new Error(`Rubric "${rubric.name}" is a score but has fewer than two levels`);
      }
      questions[id] = score(instructions, levels as [string, string, ...string[]]);
      continue;
    }

    const options = rubric.options ?? {};
    if (Object.keys(options).length < 2) {
      throw new Error(`Rubric "${rubric.name}" is a choice but has fewer than two options`);
    }
    questions[id] = choice(instructions, options);
  }

  return questions;
}
