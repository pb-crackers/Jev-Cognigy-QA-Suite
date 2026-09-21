/**
 * Deterministic units. No network, no API key, no spend.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { assemble, render } from '../src/cognigy/transcript.ts';
import { chunkTurns, estimateTokens, stateBudget } from '../src/scoring/chunk.ts';
import { combineAnswers } from '../src/scoring/combine.ts';
import { inferCombine, normalize, type Rubric } from '../src/rubrics/model.ts';
import { DEFAULT_RUBRICS } from '../src/rubrics/defaults.ts';
import { compile, questionId } from '../src/rubrics/compile.ts';
import { validateRubric } from '../src/headless.ts';
import { suggestOdataBase, missingKeys } from '../src/config.ts';
import { buildBriefing } from '../src/briefing.ts';
import { Store } from '../src/store/db.ts';
import { scoreSessions } from '../src/store/score.ts';
import type { ConversationRecord } from '../src/cognigy/odata.ts';

function record(partial: Partial<ConversationRecord>): ConversationRecord {
  return {
    id: '1', sessionId: 's1', inputId: 'i1', projectId: 'p1', projectName: 'P',
    inputText: '', inputData: '{}', type: 'output', source: 'bot',
    timestamp: '2026-09-18T10:00:00.000Z', flowName: 'Flow', channel: 'rest',
    endpointName: 'Web', inHandoverRequest: false, inHandoverConversation: false,
    rating: null, ratingComment: null, isMasked: null, ...partial,
  };
}

const rubric = (over: Partial<Rubric>): Rubric => ({
  id: 'r', name: 'R', question: 'Q?', type: 'boolean', combine: 'last',
  weight: 1, enabled: true, ...over,
});

describe('transcript assembly', () => {
  it('reassembles a streamed message from its fragments', () => {
    // The real shape: several records share a _messageId, some carry text and
    // the last carries only a finish reason.
    const records = [
      record({ inputText: 'Hi! ', inputData: '{"_cognigy":{"_messageId":"m1"}}', timestamp: '2026-09-18T10:00:00.000Z' }),
      record({ inputText: 'How can I help?', inputData: '{"_cognigy":{"_messageId":"m1"}}', timestamp: '2026-09-18T10:00:01.000Z' }),
      record({ inputText: '', inputData: '{"_cognigy":{"_messageId":"m1","_finishReason":"stop"}}', timestamp: '2026-09-18T10:00:02.000Z' }),
    ];
    const transcript = assemble('s1', records);
    assert.equal(transcript.turns.length, 1, 'three records are one turn');
    assert.equal(transcript.turns[0].text, 'Hi! How can I help?');
    assert.equal(transcript.turns[0].finishReason, 'stop');
  });

  it('never renders a fragment as a blank turn', () => {
    const transcript = assemble('s1', [
      record({ inputText: '', inputData: '{"_cognigy":{"_messageId":"m1","_finishReason":"stop"}}' }),
    ]);
    assert.equal(transcript.turns.length, 0);
    assert.equal(transcript.unscoreable, 'no-content');
  });

  it('turns a call lifecycle event into a system line', () => {
    const transcript = assemble('s1', [
      record({ inputText: 'hello', type: 'input', source: 'user' }),
      record({
        inputData: JSON.stringify({
          event: 'CALL_COMPLETED',
          payload: { duration: 42, call_termination_by: 'system', sip_reason: 'OK' },
        }),
        timestamp: '2026-09-18T10:05:00.000Z',
      }),
    ]);
    const system = transcript.turns.find((turn) => turn.role === 'system');
    assert.ok(system, 'a system line is produced');
    assert.match(system.text, /ended by system/);
    assert.match(system.text, /42s/);
  });

  it('labels a session with no endpoint as the Interaction Panel', () => {
    const transcript = assemble('s1', [record({ inputText: 'hi', endpointName: null })]);
    assert.equal(transcript.endpointLabel, 'Interaction Panel');
  });

  it('reports a masked transcript as unscoreable rather than scoring it', () => {
    const transcript = assemble('s1', [record({ inputText: 'hi', isMasked: true })]);
    assert.equal(transcript.unscoreable, 'masked');
  });

  it('separates the speakers when rendering for the model', () => {
    const text = render(
      assemble('s1', [
        record({ inputText: 'I need help', type: 'input', source: 'user' }),
        record({ inputText: 'Of course', timestamp: '2026-09-18T10:00:01.000Z' }),
      ]),
    );
    assert.equal(text, 'Customer: I need help\nAgent: Of course');
  });

  it('survives a malformed inputData payload', () => {
    const transcript = assemble('s1', [record({ inputText: 'still here', inputData: '{not json' })]);
    assert.equal(transcript.turns.length, 1);
  });
});

describe('chunking', () => {
  const turns = Array.from({ length: 40 }, (_, index) => ({
    role: 'user' as const, text: `turn number ${index} with some words in it`, at: `t${index}`,
  }));

  it('does not split a transcript that fits', () => {
    assert.equal(chunkTurns(turns, 100_000).length, 1);
  });

  it('splits only between turns, never inside one', () => {
    const chunks = chunkTurns(turns, 120);
    assert.ok(chunks.length > 1, 'a tight budget forces a split');
    for (const chunk of chunks) {
      for (const turn of chunk) assert.ok(turns.includes(turn), 'turns are passed through whole');
    }
  });

  it('repeats a little context across each boundary', () => {
    const chunks = chunkTurns(turns, 200);
    const first = chunks[0].at(-1);
    assert.ok(chunks[1].includes(first), 'the tail of one chunk opens the next');
  });

  it('leaves room for the questions in the state budget', () => {
    assert.ok(stateBudget(3_000) < stateBudget(0));
    assert.ok(stateBudget(0) < 32_000, 'the budget keeps a safety margin');
  });

  it('estimates tokens from length', () => {
    assert.ok(estimateTokens('a'.repeat(350)) >= 100);
  });
});

describe('combining chunk results', () => {
  it('passes a single chunk straight through', () => {
    const result = combineAnswers(rubric({}), [{ raw: 0.7, weight: 5 }]);
    assert.equal(result.raw, 0.7);
    assert.equal(result.chunks, 1);
  });

  it('any: a violation in one chunk is not diluted by clean ones', () => {
    // This is the case a mean would get wrong: 0.95 and two 0.02s average to 0.33.
    const result = combineAnswers(
      rubric({ combine: 'any', invert: true }),
      [{ raw: 0.02, weight: 5 }, { raw: 0.95, weight: 5 }, { raw: 0.02, weight: 5 }],
    );
    assert.equal(result.raw, 0.95);
    assert.equal(result.decidedBy, 1);
  });

  it('last: an early "not yet" does not drag down a resolved ending', () => {
    const result = combineAnswers(
      rubric({ combine: 'last' }),
      [{ raw: 0.05, weight: 5 }, { raw: 0.05, weight: 5 }, { raw: 0.93, weight: 5 }],
    );
    assert.equal(result.raw, 0.93);
    assert.equal(result.decidedBy, 2);
  });

  it('mean: weights by chunk length rather than treating chunks as equal', () => {
    const result = combineAnswers(
      rubric({ combine: 'mean', type: 'score', levels: ['a', 'b', 'c'] }),
      [{ raw: 0, weight: 1 }, { raw: 2, weight: 9 }],
    );
    assert.ok(Math.abs(Number(result.raw) - 1.8) < 1e-9, 'a long chunk counts for more');
  });

  it('confidence folds to the weakest judgement, not the average', () => {
    const result = combineAnswers(
      rubric({ combine: 'mean', type: 'score', levels: ['a', 'b'] }),
      [{ raw: 1, confidence: 0.9, weight: 1 }, { raw: 1, confidence: 0.2, weight: 1 }],
    );
    assert.equal(result.confidence, 0.2);
  });

  it('any: for a choice, the worst-scoring option wins', () => {
    const result = combineAnswers(
      rubric({
        combine: 'any', type: 'choice',
        options: { good: 'g', bad: 'b' }, optionScores: { good: 1, bad: 0 },
      }),
      [{ raw: 'good', weight: 1 }, { raw: 'bad', weight: 1 }],
    );
    assert.equal(result.raw, 'bad');
  });
});

describe('inferred combine mode', () => {
  it('counts a violation that happened anywhere', () => {
    assert.equal(inferCombine({ type: 'boolean', invert: true }), 'any');
  });

  it('lets the end of the conversation settle an outcome', () => {
    assert.equal(inferCombine({ type: 'boolean', invert: false }), 'last');
    assert.equal(inferCombine({ type: 'choice' }), 'last');
  });

  it('averages a graded quality across the conversation', () => {
    assert.equal(inferCombine({ type: 'score' }), 'mean');
  });

  it('matches what the starter rubrics were hand-tuned to', () => {
    for (const rubric of DEFAULT_RUBRICS) {
      assert.equal(
        inferCombine(rubric),
        rubric.combine,
        `${rubric.name} would be folded differently than it declares`,
      );
    }
  });
});

describe('normalisation', () => {
  it('inverts a boolean where a yes is the bad outcome', () => {
    assert.equal(normalize(rubric({ invert: true }), 1), 0);
    assert.equal(normalize(rubric({ invert: false }), 1), 1);
  });

  it('inverts a score where a high level is the bad outcome', () => {
    const frustration = rubric({ type: 'score', levels: ['calm', 'mild', 'angry'], invert: true });
    assert.equal(normalize(frustration, 2), 0);
    assert.equal(normalize(frustration, 0), 1);
  });

  it('leaves a choice unscored when no goodness was given', () => {
    const noScores = rubric({ type: 'choice', options: { a: 'a', b: 'b' } });
    assert.equal(normalize(noScores, 'a'), undefined);
  });
});

describe('rubric compilation', () => {
  it('maps each type to its primitive', () => {
    const questions = compile([
      rubric({ id: 'b' }),
      rubric({ id: 's', type: 'score', levels: ['low', 'high'] }),
      rubric({ id: 'c', type: 'choice', options: { x: 'x', y: 'y' } }),
    ]);
    assert.equal(questions[questionId(rubric({ id: 'b' }))].type, 'noul');
    assert.equal(questions.r_s.type, 'score');
    assert.equal(questions.r_c.type, 'choice');
  });

  it('compiles the whole starter set into one question map', () => {
    const questions = compile(DEFAULT_RUBRICS);
    assert.equal(Object.keys(questions).length, DEFAULT_RUBRICS.length);
  });

  it('refuses a score with too few levels rather than sending it', () => {
    assert.throws(() => compile([rubric({ type: 'score', levels: ['only'] })]), /fewer than two/);
  });
});

describe('rubric validation', () => {
  it('reports every problem at once', () => {
    // name, question and type. `combine` is derived, not required of the author.
    assert.equal(validateRubric({}).length, 3);
  });

  it('does not require a combine mode, because the tool derives one', () => {
    const problems = validateRubric({
      name: 'R', question: 'Q?', type: 'boolean',
    });
    assert.deepEqual(problems, []);
  });

  it('still rejects a combine mode that is not one of the three', () => {
    const problems = validateRubric({
      name: 'R', question: 'Q?', type: 'boolean', combine: 'sideways',
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /combine, if given/);
  });

  it('accepts a well-formed rubric', () => {
    assert.deepEqual(validateRubric(rubric({})), []);
  });

  it('requires a goodness for every choice option', () => {
    const problems = validateRubric(
      rubric({ type: 'choice', options: { a: 'a', b: 'b' }, optionScores: { a: 1 } }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /optionScores is missing/);
  });
});

describe('configuration', () => {
  it('derives the region-matched OData host from the API host', () => {
    assert.equal(
      suggestOdataBase('https://api-trial-us.cognigy.ai'),
      'https://odata-trial-us.cognigy.ai/v2.4',
    );
  });

  it('names every missing key rather than the first', () => {
    assert.equal(missingKeys({}).length, 4);
  });
});

describe('storage and re-weighting', () => {
  it('stores a session whose optional label was omitted, rather than throwing', () => {
    const store = new Store(':memory:');
    store.saveRun({
      id: 'r', startedAt: 'now', projectId: 'p', projectName: 'P', endpointLabel: 'Any',
      fromTs: 'a', toTs: 'b', sessions: 1, costUsd: 0, ms: 0,
    });
    store.saveSession(
      {
        runId: 'r', sessionId: 's', startedAt: 'now', endpointLabel: 'Web', channel: 'rest',
        flowName: null, turns: 1, chunks: 1, rating: null, ratingComment: null,
        unscoreable: null, transcript: '[]', costUsd: 0, ms: 0,
      } as never,
      [],
    );
    assert.equal(store.sessionsForRun('r')[0].channelLabel, null);
    store.close();
  });

  it('seeds the starter set only into an empty library', () => {
    const store = new Store(':memory:');
    assert.equal(store.seedRubrics(DEFAULT_RUBRICS), true);
    assert.equal(store.seedRubrics(DEFAULT_RUBRICS), false);
    assert.equal(store.rubrics().length, DEFAULT_RUBRICS.length);
    store.close();
  });

  it('re-weighting changes the composite without touching stored results', () => {
    const store = new Store(':memory:');
    const helped = rubric({ id: 'helped', weight: 1 });
    const strayed = rubric({ id: 'strayed', weight: 1, invert: true });

    store.saveRun({
      id: 'run1', startedAt: 'now', projectId: 'p1', projectName: 'P',
      endpointLabel: 'Any', fromTs: 'a', toTs: 'b', sessions: 1, costUsd: 0, ms: 0,
    });
    store.saveSession(
      {
        runId: 'run1', sessionId: 's1', startedAt: 'now', endpointLabel: 'Web',
        channel: 'rest', channelLabel: 'REST API', flowName: 'F', turns: 4, chunks: 1, rating: null,
        ratingComment: null, unscoreable: null, transcript: '[]', costUsd: 0, ms: 0,
      },
      [
        { runId: 'run1', sessionId: 's1', rubricId: 'helped', raw: '1', confidence: null, chunks: 1, decidedBy: null },
        { runId: 'run1', sessionId: 's1', rubricId: 'strayed', raw: '1', confidence: null, chunks: 1, decidedBy: null },
      ],
    );

    const sessions = store.sessionsForRun('run1');
    const results = store.resultsForRun('run1');

    // Equal weights: one good, one bad, so the composite sits in the middle.
    const even = scoreSessions(sessions, results, [helped, strayed])[0];
    assert.ok(Math.abs(even.composite - 2.5) < 1e-9);

    // Weight the violation more heavily and the same stored rows score worse.
    const harsh = scoreSessions(sessions, results, [helped, { ...strayed, weight: 4 }])[0];
    assert.ok(harsh.composite < even.composite, 'the composite moved');
    assert.equal(store.resultsForRun('run1').length, 2, 'stored results are untouched');
    store.close();
  });

  it('flags a low-confidence result for review without altering its score', () => {
    const store = new Store(':memory:');
    store.saveRun({
      id: 'r', startedAt: 'now', projectId: 'p', projectName: 'P', endpointLabel: 'Any',
      fromTs: 'a', toTs: 'b', sessions: 1, costUsd: 0, ms: 0,
    });
    store.saveSession(
      {
        runId: 'r', sessionId: 's', startedAt: 'now', endpointLabel: 'Web', channel: null,
        channelLabel: null, flowName: null, turns: 2, chunks: 1, rating: null, ratingComment: null,
        unscoreable: null, transcript: '[]', costUsd: 0, ms: 0,
      },
      [{ runId: 'r', sessionId: 's', rubricId: 'tone', raw: '1', confidence: 0.2, chunks: 1, decidedBy: null }],
    );
    const scored = scoreSessions(
      store.sessionsForRun('r'), store.resultsForRun('r'),
      [rubric({ id: 'tone', type: 'score', levels: ['a', 'b', 'c'] })],
    )[0];
    assert.deepEqual(scored.flagged, ['tone']);
    assert.equal(scored.results.get('tone').raw, 1, 'the score itself is unchanged');
    store.close();
  });

  it('remembers which sessions a project has already scored', () => {
    const store = new Store(':memory:');
    store.saveRun({
      id: 'r', startedAt: 'now', projectId: 'p1', projectName: 'P', endpointLabel: 'Any',
      fromTs: 'a', toTs: 'b', sessions: 1, costUsd: 0, ms: 0,
    });
    store.saveSession(
      {
        runId: 'r', sessionId: 'seen', startedAt: 'now', endpointLabel: 'Web', channel: null,
        channelLabel: null, flowName: null, turns: 1, chunks: 1, rating: null, ratingComment: null,
        unscoreable: null, transcript: '[]', costUsd: 0, ms: 0,
      },
      [],
    );
    assert.ok(store.alreadyScored('p1').has('seen'));
    assert.equal(store.alreadyScored('other').size, 0);
    store.close();
  });
});

describe('briefing', () => {
  const rubrics = [
    rubric({ id: 'helped', name: 'Customer was helped', question: 'Was the customer helped?' }),
    rubric({ id: 'strayed', name: 'Agent strayed', question: 'Did it stray?', invert: true }),
  ];

  const run = {
    id: 'run1', startedAt: '2026-09-18T10:00:00Z', projectId: 'p', projectName: 'Insurance',
    endpointLabel: 'Any endpoint', fromTs: '2026-09-01T00:00:00Z', toTs: '2026-09-18T00:00:00Z',
    sessions: 2, costUsd: 0.0002, ms: 1800,
  };

  const session = (id: string, transcript: unknown[], unscoreable: string | null = null) => ({
    runId: 'run1', sessionId: id, startedAt: '2026-09-18T10:00:00Z', endpointLabel: 'Web',
    channel: 'rest', flowName: 'Quote', turns: transcript.length, chunks: 1, rating: null,
    ratingComment: null, unscoreable, transcript: JSON.stringify(transcript), costUsd: 0, ms: 0,
  });

  const result = (sessionId: string, rubricId: string, raw: string, confidence: number | null = 0.9) => ({
    runId: 'run1', sessionId, rubricId, raw, confidence, chunks: 1, decidedBy: null,
  });

  const turns = [
    { role: 'user', text: 'I need a quote' },
    { role: 'agent', text: 'Give me ten things' },
    { role: 'user', text: 'ugh' },
  ];

  it('leads with the worst rubric and explains what it measures', () => {
    const markdown = buildBriefing(
      run,
      [session('s1', turns), session('s2', turns)],
      [
        result('s1', 'helped', '0.02'), result('s2', 'helped', '0.03'),
        result('s1', 'strayed', '0.01'), result('s2', 'strayed', '0.02'),
      ],
      rubrics,
    );
    const helpedAt = markdown.indexOf('Customer was helped —');
    const strayedAt = markdown.indexOf('Agent strayed —');
    assert.ok(helpedAt > -1, 'the failing rubric is reported');
    assert.ok(strayedAt === -1, 'a rubric scoring well is not listed as something to fix');
    assert.match(markdown, /What this measures:\*\*\s*Was the customer helped\?/);
  });

  it('quotes real transcript evidence rather than only numbers', () => {
    const markdown = buildBriefing(run, [session('s1', turns)], [result('s1', 'helped', '0.02')], rubrics);
    assert.match(markdown, /\*\*Customer:\*\* I need a quote/);
    assert.match(markdown, /\*\*Agent:\*\* Give me ten things/);
  });

  it('excludes unscoreable sessions from the averages and says so', () => {
    const markdown = buildBriefing(
      run,
      [session('s1', turns), session('s2', [], 'masked')],
      [result('s1', 'helped', '0.02')],
      rubrics,
    );
    assert.match(markdown, /1 session\(s\) were not scoreable/);
  });

  it('warns when a rubric is mostly low-confidence, since that implicates the rubric', () => {
    const markdown = buildBriefing(
      run,
      [session('s1', turns), session('s2', turns)],
      [result('s1', 'helped', '0.1', 0.1), result('s2', 'helped', '0.1', 0.2)],
      rubrics,
    );
    assert.match(markdown, /low-confidence/);
    assert.match(markdown, /probably the problem, not/);
  });
});

describe('voice transcripts', () => {
  it('keeps a spoken turn that also carries an event', () => {
    // On a voice call the caller's words arrive as a RECOGNIZED_SPEECH event
    // with the text in inputText. Treating the event as a lifecycle line
    // discarded every caller turn and left agent-only transcripts.
    const transcript = assemble('s1', [
      record({
        inputText: 'I was wondering if you could help me with a home insurance quote.',
        inputData: JSON.stringify({ event: 'RECOGNIZED_SPEECH', payload: { reason: 'speechDetected' } }),
        type: 'input', source: 'user',
      }),
    ]);
    assert.equal(transcript.turns.length, 1);
    assert.equal(transcript.turns[0].role, 'user');
    assert.match(transcript.turns[0].text, /home insurance quote/);
    assert.equal(transcript.unscoreable, undefined);
  });

  it('still renders a textless lifecycle event as a system line', () => {
    const transcript = assemble('s1', [
      record({ inputText: 'hello', type: 'input', source: 'user' }),
      record({
        inputText: '',
        inputData: JSON.stringify({ event: 'CALL_COMPLETED', payload: { duration: 12, call_termination_by: 'caller' } }),
        timestamp: '2026-09-18T10:02:00.000Z',
      }),
    ]);
    const system = transcript.turns.find((turn) => turn.role === 'system');
    assert.ok(system);
    assert.match(system.text, /ended by caller/);
  });

  it('a whole voice call reads as a conversation, not a list of events', () => {
    const speech = (text: string, at: string) =>
      record({
        inputText: text, type: 'input', source: 'user', timestamp: at,
        inputData: JSON.stringify({ event: 'RECOGNIZED_SPEECH', payload: {} }),
      });
    const transcript = assemble('s1', [
      record({ inputText: '', inputData: JSON.stringify({ event: 'CALL_CREATED', payload: { direction: 'inbound' } }), timestamp: '2026-09-18T10:00:00.000Z' }),
      record({ inputText: 'How may I help?', timestamp: '2026-09-18T10:00:01.000Z' }),
      speech('I need a quote', '2026-09-18T10:00:02.000Z'),
      record({ inputText: 'Of course.', timestamp: '2026-09-18T10:00:03.000Z' }),
    ]);
    const spoken = transcript.turns.filter((turn) => turn.role !== 'system');
    assert.equal(spoken.length, 3, 'two agent turns and one caller turn survive');
    assert.equal(spoken.filter((turn) => turn.role === 'user').length, 1);
    assert.match(render(transcript), /Customer: I need a quote/);
  });
});
