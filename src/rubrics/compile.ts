/**
 * Compiles rubrics into Jev questions.
 *
 * Every rubric in a run goes into one request, because Jev reads the state once
 * and answers all questions against it in parallel — twenty rubrics cost the
 * same round trip as one.
 */
import { choice, noul, score } from '@typesafe-ai/sdk';
import type { Questions } from '@typesafe-ai/sdk';
import type { Rubric } from './model.ts';

/** Question id for a rubric, kept stable so answers can be matched back. */
export function questionId(rubric: Rubric): string {
  return `r_${rubric.id}`;
}

export function compile(rubrics: Rubric[]): Questions {
  const questions: Questions = {};

  for (const rubric of rubrics) {
    const id = questionId(rubric);

    if (rubric.type === 'boolean') {
      const instructions = {
        question: rubric.question,
        focus: 'Judge only this question, against the conversation as given.',
      };
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
      questions[id] = score(rubric.question, levels as [string, string, ...string[]]);
      continue;
    }

    const options = rubric.options ?? {};
    if (Object.keys(options).length < 2) {
      throw new Error(`Rubric "${rubric.name}" is a choice but has fewer than two options`);
    }
    questions[id] = choice(rubric.question, options);
  }

  return questions;
}
