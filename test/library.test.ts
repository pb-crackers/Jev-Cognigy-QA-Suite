/**
 * The shipped rubric library, its once-only seeding, and the validation of the
 * fields Agent Watch added to a rubric. No network.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LIBRARY_RUBRICS } from '../src/rubrics/library.ts';
import { DEFAULT_RUBRICS } from '../src/rubrics/defaults.ts';
import { watchFieldProblems, type Rubric } from '../src/rubrics/model.ts';
import { compile } from '../src/rubrics/compile.ts';
import { completeRubric, validateRubric } from '../src/headless.ts';
import { Store } from '../src/store/db.ts';

describe('the shipped library', () => {
  it('is valid and compiles to Jev questions', () => {
    for (const rubric of LIBRARY_RUBRICS) assert.deepEqual(validateRubric(rubric), [], rubric.id);
    assert.equal(Object.keys(compile(LIBRARY_RUBRICS)).length, LIBRARY_RUBRICS.length);
  });

  it('never lets an attack on the agent lower its health', () => {
    const attempt = LIBRARY_RUBRICS.find((rubric) => rubric.id === 'jailbreak_attempt')!;
    assert.equal(attempt.weight, 0);
    assert.deepEqual(attempt.alert, { threshold: 10, window: 'day' });
  });

  it('alerts on the first real breach', () => {
    for (const id of ['jailbroken', 'disclosed_instructions', 'sensitive_data_request', 'harmful_content']) {
      const rubric = LIBRARY_RUBRICS.find((candidate) => candidate.id === id)!;
      assert.deepEqual(rubric.alert, { threshold: 1, window: 'session' }, id);
      assert.ok(rubric.weight > 0, `${id} counts against health`);
    }
  });

  it('marks what only a trace can answer', () => {
    const traced = LIBRARY_RUBRICS.filter((rubric) => rubric.requiresTrace).map((rubric) => rubric.id).sort();
    assert.deepEqual(traced, ['claimed_action_without_tool', 'figures_without_tool', 'invented_tool_arguments', 'off_instruction']);
  });

  it('states an intent for every rubric, so validity has something to check against', () => {
    assert.ok(LIBRARY_RUBRICS.every((rubric) => rubric.intent));
  });
});

describe('seeding the library', () => {
  const shipped = [...DEFAULT_RUBRICS.map((rubric) => rubric.id), ...LIBRARY_RUBRICS.map((rubric) => rubric.id)];

  it('adds each library rubric once, after what is already there', () => {
    const store = new Store(':memory:');
    store.seedRubrics(DEFAULT_RUBRICS);
    const added = store.seedLibrary(LIBRARY_RUBRICS, shipped);
    assert.equal(added.length, LIBRARY_RUBRICS.length);
    assert.equal(store.rubrics().length, DEFAULT_RUBRICS.length + LIBRARY_RUBRICS.length);
    assert.deepEqual(store.seedLibrary(LIBRARY_RUBRICS, shipped), [], 'a second start adds nothing');
    store.close();
  });

  it('does not bring back a library rubric the user deleted, or overwrite one they edited', () => {
    const store = new Store(':memory:');
    store.seedLibrary(LIBRARY_RUBRICS, shipped);
    store.deleteRubric('harmful_content');
    const edited = store.rubrics().find((rubric) => rubric.id === 'jailbroken')!;
    store.saveRubric({ ...edited, question: 'My own wording?' });
    store.seedLibrary(LIBRARY_RUBRICS, shipped);
    assert.ok(!store.rubrics().some((rubric) => rubric.id === 'harmful_content'));
    assert.equal(store.rubrics().find((rubric) => rubric.id === 'jailbroken')!.question, 'My own wording?');
    store.close();
  });

  it('marks starter rubrics stored before origin existed as library rubrics', () => {
    const store = new Store(':memory:');
    const { origin: _origin, ...legacy } = DEFAULT_RUBRICS[0];
    store.saveRubric(legacy as Rubric);
    store.seedLibrary(LIBRARY_RUBRICS, shipped);
    assert.equal(store.rubrics().find((rubric) => rubric.id === DEFAULT_RUBRICS[0].id)!.origin, 'library');
    store.close();
  });
});

describe('Agent Watch fields on a rubric', () => {
  const base: Partial<Rubric> = { id: 'x', name: 'X', question: 'Q?', type: 'boolean' };

  it('requires an alert to be a yes/no question with a threshold and a window', () => {
    assert.deepEqual(watchFieldProblems({ ...base, kind: 'alert', alert: { threshold: 1, window: 'session' } }), []);
    assert.ok(watchFieldProblems({ ...base, kind: 'alert' }).some((p) => p.includes('needs alert')));
    assert.ok(watchFieldProblems({ ...base, type: 'score', kind: 'alert', alert: { threshold: 1, window: 'day' } })
      .some((p) => p.includes('must be a boolean')));
    assert.ok(watchFieldProblems({ ...base, kind: 'alert', alert: { threshold: 0, window: 'day' } })
      .some((p) => p.includes('threshold')));
    assert.ok(watchFieldProblems({ ...base, kind: 'alert', alert: { threshold: 2, window: 'week' as 'day' } })
      .some((p) => p.includes('window')));
  });

  it('refuses a session window with a threshold above one, which could never fire', () => {
    assert.ok(watchFieldProblems({ ...base, kind: 'alert', alert: { threshold: 3, window: 'session' } })
      .some((p) => p.includes('session window can only have a threshold of 1')));
  });

  it('rejects an unknown kind and an over-long intent', () => {
    assert.ok(watchFieldProblems({ ...base, kind: 'urgent' as 'alert' }).length > 0);
    assert.ok(watchFieldProblems({ ...base, intent: 'x'.repeat(501) }).length > 0);
  });

  it('treats a rubric an agent writes as custom, and a shipped id as library', () => {
    assert.equal(completeRubric({ ...base, combine: 'last', weight: 1, enabled: true } as Rubric).origin, 'custom');
    assert.equal(completeRubric({ ...LIBRARY_RUBRICS[0], origin: undefined }).origin, 'library');
  });
});
