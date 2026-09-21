/**
 * Modality scoping: which rubrics are asked of a conversation, and what extra
 * instruction they carry. Pure; no network, no API key, no spend.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { labelFor, modalityOf } from '../src/cognigy/channels.ts';
import { applies, type Rubric } from '../src/rubrics/model.ts';
import { applicable, compile, questionId } from '../src/rubrics/compile.ts';
import { validateRubric } from '../src/headless.ts';

const rubric = (over: Partial<Rubric>): Rubric => ({
  id: 'r', name: 'R', question: 'Q?', type: 'boolean', combine: 'last',
  weight: 1, enabled: true, ...over,
});

const instructionsOf = (questions: ReturnType<typeof compile>, id: string) =>
  questions[id].instructions as { question: string; focus: string; note?: string };

describe('modality of a channel', () => {
  it('maps a voice gateway to voice', () => {
    assert.equal(modalityOf(labelFor('voiceGateway2').kind), 'voice');
  });

  it('treats the Interaction Panel as text, never as its own modality', () => {
    // The reviewer still sees "Interaction Panel"; the rubric must not.
    assert.equal(labelFor('adminconsole').label, 'Interaction Panel');
    assert.equal(modalityOf(labelFor('adminconsole').kind), modalityOf(labelFor('rest').kind));
    assert.equal(modalityOf(labelFor('adminconsole').kind), 'text');
  });

  it('cannot establish a modality for an unmapped or absent channel', () => {
    assert.equal(modalityOf(labelFor('someNewChannel').kind), undefined);
    assert.equal(modalityOf(labelFor(null).kind), undefined);
  });
});

describe('which rubrics apply', () => {
  const general = rubric({ id: 'a' });
  const voiceOnly = rubric({ id: 'b', appliesTo: 'voice' });
  const textOnly = rubric({ id: 'c', appliesTo: 'text' });
  const all = [general, voiceOnly, textOnly];

  it('asks an unscoped rubric of every modality', () => {
    for (const modality of ['voice', 'text', undefined] as const) {
      assert.equal(applies(general, modality), true);
    }
  });

  it('skips a voice-only rubric on a text conversation', () => {
    assert.deepEqual(applicable(all, 'text').map((r) => r.id), ['a', 'c']);
  });

  it('skips a text-only rubric on a voice call', () => {
    assert.deepEqual(applicable(all, 'voice').map((r) => r.id), ['a', 'b']);
  });

  it('asks every rubric when the modality could not be established', () => {
    // The decision recorded in the brief: a score not taken cannot be recovered,
    // whereas a question asked of the wrong modality is visibly weak and can be
    // discounted. Half the observed sessions carry no channel at all.
    assert.deepEqual(applicable(all, undefined).map((r) => r.id), ['a', 'b', 'c']);
    assert.equal(Object.keys(compile(all, undefined)).length, 3);
  });
});

describe('compiled instructions', () => {
  it('keeps the author’s wording intact when there is no note', () => {
    const questions = compile([rubric({ question: 'Was it resolved?' })]);
    assert.equal(instructionsOf(questions, 'r_r').question, 'Was it resolved?');
    assert.equal(instructionsOf(questions, 'r_r').note, undefined);
  });

  it('appends a note only for the modality it was written for', () => {
    const r = rubric({ notes: { voice: 'Speech recognition may mishear names.' } });
    assert.equal(instructionsOf(compile([r], 'voice'), 'r_r').note, 'Speech recognition may mishear names.');
    assert.equal(instructionsOf(compile([r], 'text'), 'r_r').note, undefined);
    assert.equal(instructionsOf(compile([r], undefined), 'r_r').note, undefined);
  });

  it('carries the note on all three question types', () => {
    const notes = { voice: 'Heard, not read.' };
    const types: Rubric[] = [
      rubric({ id: 'b', type: 'boolean', notes }),
      rubric({ id: 's', type: 'score', levels: ['bad', 'good'], notes }),
      rubric({ id: 'c', type: 'choice', options: { yes: 'y', no: 'n' }, notes }),
    ];
    const questions = compile(types, 'voice');
    for (const r of types) {
      assert.equal(instructionsOf(questions, questionId(r)).note, 'Heard, not read.');
    }
  });

  it('still refuses a score rubric with too few levels', () => {
    assert.throws(() => compile([rubric({ type: 'score', levels: ['only'] })]), /fewer than two levels/);
  });
});

describe('agent-authored rubric validation', () => {
  it('rejects a scope that is not a modality', () => {
    const problems = validateRubric({ ...rubric({}), appliesTo: 'panel' });
    assert.ok(problems.some((p) => p.includes('appliesTo')));
  });

  it('rejects a note for a modality the rubric never runs on', () => {
    const problems = validateRubric({
      ...rubric({ appliesTo: 'voice' }),
      notes: { text: 'never sent' },
    });
    assert.ok(problems.some((p) => p.includes('cannot carry a note')));
  });

  it('accepts a correctly scoped rubric with its note', () => {
    assert.deepEqual(
      validateRubric({ ...rubric({ appliesTo: 'voice' }), notes: { voice: 'Heard, not read.' } }),
      [],
    );
  });
});
