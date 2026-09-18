/**
 * The starter rubric set.
 *
 * Each one is written as a question about the conversation rather than about the
 * agent's opinion of itself, and each carries the combine mode its meaning
 * implies. These are meant to be edited — they are a starting point that shows
 * what a good rubric looks like, not a standard.
 */
import type { Rubric } from './model.ts';

export const DEFAULT_RUBRICS: Rubric[] = [
  {
    id: 'helped',
    name: 'Customer was helped',
    question: "Did the customer's actual problem get resolved by the end of this conversation?",
    type: 'boolean',
    combine: 'last',
    weight: 3,
    enabled: true,
    trueMeans: 'The customer got what they came for, or a concrete next step that addresses it.',
    falseMeans: 'The conversation ended with the need unmet, deflected, or abandoned.',
  },
  {
    id: 'knowledge_relevant',
    name: 'Knowledge answer was relevant',
    question: "How well did the agent's answers address what the customer actually asked?",
    type: 'score',
    combine: 'mean',
    weight: 2,
    enabled: true,
    levels: [
      'Answered something the customer did not ask',
      'Partially relevant, or answered a broader version of the question',
      'Directly answered what was asked',
    ],
  },
  {
    id: 'strayed',
    name: 'Agent strayed from instructions',
    question: 'Did the agent do something outside the role and task it was given?',
    type: 'boolean',
    combine: 'any',
    weight: 3,
    enabled: true,
    invert: true,
    trueMeans:
      'Went off-task, invented policy or product terms, discussed unrelated subjects, or acted outside its remit.',
    falseMeans: 'Stayed within its role and task throughout.',
  },
  {
    id: 'repeated',
    name: 'Asked for something already given',
    question:
      'Did the agent ask the customer for information the customer had already provided?',
    type: 'boolean',
    combine: 'any',
    weight: 2,
    enabled: true,
    invert: true,
    trueMeans: 'Re-asked for a detail the customer had already stated.',
    falseMeans: 'Never asked twice for the same detail.',
  },
  {
    id: 'handover_timing',
    name: 'Handover timing',
    question:
      'If the conversation moved toward a human, or should have, was the timing right?',
    type: 'choice',
    combine: 'last',
    weight: 1,
    enabled: true,
    options: {
      not_needed: 'No handover happened and none was needed',
      right: 'Escalated at about the right point',
      too_early: 'Escalated before making a reasonable attempt',
      too_late: 'Should have escalated sooner than it did',
      never_should_have: 'Needed a human and never offered one',
    },
    optionScores: { not_needed: 1, right: 1, too_early: 0.5, too_late: 0.25, never_should_have: 0 },
  },
  {
    id: 'tone',
    name: 'Tone',
    question: "How appropriate was the agent's tone for this customer's situation?",
    type: 'score',
    combine: 'mean',
    weight: 1,
    enabled: true,
    levels: [
      'Inappropriate — dismissive, robotic, or mismatched to the situation',
      'Acceptable but flat',
      'Well matched to the situation',
    ],
  },
  {
    id: 'frustration',
    name: 'Customer frustration',
    question: 'How frustrated did the customer become over the course of the conversation?',
    type: 'score',
    combine: 'mean',
    weight: 2,
    enabled: true,
    invert: true,
    levels: [
      'Calm throughout',
      'Mild friction — had to restate or clarify',
      'Clearly frustrated',
      'Angry or gave up',
    ],
  },
  {
    id: 'ended_well',
    name: 'Conversation ended cleanly',
    question: 'Did the conversation reach a proper ending rather than being cut off?',
    type: 'boolean',
    combine: 'last',
    weight: 1,
    enabled: true,
    trueMeans: 'Closed with a resolution, a next step, or a handover the customer accepted.',
    falseMeans: 'Cut off mid-task, or the agent ended it while the customer still needed something.',
  },
];
