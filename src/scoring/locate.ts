/**
 * Which agent message a rubric's verdict rests on.
 *
 * Jev answers a rubric for the whole conversation and never says where. So,
 * once there is a verdict, Jev is asked one more question — a choice between
 * the agent's messages, plus "no single message" — about why it gave that
 * answer. The message it picks is what the session view marks; how far its
 * probability stands above the next option decides whether to mark anything.
 *
 * One question, not one per message: it asks exactly "why this answer", and
 * "no single message" is an honest option for verdicts that rest on the
 * conversation as a whole, like whether the customer was helped.
 */
import { createHash } from 'node:crypto';
import { choice } from '@typesafe-ai/sdk';
import type { Questions } from '@typesafe-ai/sdk';
import type { Turn } from '../cognigy/transcript.ts';
import { ask } from '../jev.ts';
import type { Ledger } from '../metering.ts';
import type { Rubric } from '../rubrics/model.ts';
import { estimateTokens, stateBudget } from './chunk.ts';
import { fixedState, withToolLines, type FixedState } from './state.ts';
import { reconstruct } from '../traces/reconstruct.ts';
import type { Agent } from '../agents/model.ts';
import type { Store } from '../store/db.ts';
import { Ledger as LedgerClass } from '../metering.ts';

/**
 * A message is marked when Jev gives it at least this probability, and at least
 * LOCATE_MARGIN more than the next option. Jev's own `confidence` is a stricter
 * concentration measure — a clear 0.64 against 0.18 reads 0.53 — so it isn't
 * what decides.
 */
export const LOCATE_PROBABILITY = 0.5;
export const LOCATE_MARGIN = 0.15;
/** Bumped when what a stored pointer means changes, so older ones are asked again. */
const LOCATE_VERSION = 'p2';
const NONE = 'none';
/** Enough of a message to recognise it in a list of options. */
const OPENING_CHARS = 90;

export interface Located {
  /** The raw answer this was asked about. */
  raw: string;
  /**
   * What the question depended on: the answer, the rubric's question, and how
   * many agent messages there were. A new answer, an edited question or a
   * conversation that grew means asking again.
   */
  key?: string;
  /** Index into the stored transcript's turns, or null for no single message. */
  turnIndex: number | null;
  /** Which message, counting from 1 among the agent's or the customer's (see `about`). */
  message: number | null;
  /** Whose messages were the options: the rubric's subject. */
  about?: 'agent' | 'customer';
  /** Jev's probability for the message it picked — what the session view shows. */
  probability: number | null;
  /** The next most likely option's probability: how clear the pick was. */
  runnerUp?: number | null;
  /** Why nothing was pointed at, when nothing was. */
  reason?: string;
}

/** Jev's answer in words: what the pointing question states as the verdict. */
export function verdictText(rubric: Rubric, raw: string): string {
  if (rubric.type === 'boolean') return Number(raw) >= 0.5 ? 'yes' : 'no';
  if (rubric.type === 'score') {
    const level = Number(raw);
    const nearest = rubric.levels?.[Math.round(level)];
    // Chunks averaged together can land between levels; say which it was closest to.
    if (nearest === undefined) return raw;
    return Number.isInteger(level) ? nearest : `about ${nearest}`;
  }
  return raw;
}

/** Whose messages a rubric points at, and the transcript role they have. */
function subjectOf(rubric: Rubric): { about: 'agent' | 'customer'; role: Turn['role'] } {
  return rubric.about === 'customer' ? { about: 'customer', role: 'user' } : { about: 'agent', role: 'agent' };
}

export function locateKey(rubric: Rubric, raw: string, turns: Pick<Turn, 'role'>[]): string {
  const question = createHash('sha256').update(rubric.question).digest('hex').slice(0, 12);
  const { about, role } = subjectOf(rubric);
  return `${LOCATE_VERSION}|${raw}|${question}|${about}|${turns.filter((turn) => turn.role === role).length}`;
}

function opening(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= OPENING_CHARS ? flat : `${flat.slice(0, OPENING_CHARS - 1)}…`;
}

type Numbered = { message: number; turnIndex: number; text: string };

/** The conversation with the agent's and the customer's messages numbered, so options can name them. */
function numbered(turns: Turn[]): { text: string; agent: Numbered[]; customer: Numbered[] } {
  const agent: Numbered[] = [];
  const customer: Numbered[] = [];
  const lines = turns.map((turn, index) => {
    if (turn.role === 'system') return turn.text;
    const list = turn.role === 'user' ? customer : agent;
    list.push({ message: list.length + 1, turnIndex: index, text: turn.text });
    return `${turn.role === 'user' ? 'Customer' : 'Agent'} message ${list.length}: ${turn.text}`;
  });
  return { text: lines.join('\n'), agent, customer };
}

function whichQuestion(rubric: Rubric, raw: string, messages: { message: number; text: string }[]) {
  const who = subjectOf(rubric).about === 'customer' ? 'customer' : 'agent';
  const Who = who === 'customer' ? 'Customer' : 'Agent';
  const options: Record<string, string> = {};
  for (const item of messages) options[`message_${item.message}`] = `${Who} message ${item.message}: "${opening(item.text)}"`;
  options[NONE] = 'No single message: the answer rests on the conversation as a whole.';
  return choice({
    question: `For this conversation, the answer to "${rubric.question}" was ${verdictText(rubric, raw)}. Which ${who} message is the main reason for that answer?`,
    focus: `Pick the one ${who} message the answer rests on most. Pick "none" when no single message decides it.`,
  }, options);
}

const questionId = (rubric: Rubric) => `which_${rubric.id}`;

type Pick = { choice?: string; confidence?: number; probabilities?: Record<string, number> } | undefined;

function readPick(answer: Pick, messages: { message: number; turnIndex: number }[], raw: string): Located {
  const probabilities = answer?.probabilities ?? {};
  // Without a distribution, Jev's confidence is the closest stand-in for the pick's probability.
  const probability = answer?.choice ? probabilities[answer.choice] ?? answer.confidence ?? null : null;
  const others = Object.entries(probabilities).filter(([label]) => label !== answer?.choice).map(([, value]) => value);
  const runnerUp = others.length ? Math.max(...others) : null;
  const picked = answer?.choice?.match(/^message_(\d+)$/);
  if (!picked) return { raw, turnIndex: null, message: null, probability, runnerUp, reason: 'no single message decides this one' };
  const found = messages.find((item) => item.message === Number(picked[1]));
  if (!found) return { raw, turnIndex: null, message: null, probability, runnerUp, reason: 'Jev named a message that isn’t there' };
  const clear = probability !== null && probability >= LOCATE_PROBABILITY && probability - (runnerUp ?? 0) >= LOCATE_MARGIN;
  if (!clear) return { raw, turnIndex: null, message: found.message, probability, runnerUp, reason: 'Jev isn’t sure which message' };
  return { raw, turnIndex: found.turnIndex, message: found.message, probability, runnerUp };
}

/**
 * Asks which message each of several answers rests on, in as few requests as
 * fit: every question reads the same conversation, and Jev answers all the
 * questions in a request against one reading of it. `turns` are the
 * conversation as the grader read it, tool lines included; `fixed` is the
 * instructions and tools it was given.
 */
export async function locateAll(
  answers: { rubric: Rubric; raw: string }[],
  turns: Turn[],
  fixed: FixedState,
  ledger: Ledger,
  sessionId: string,
): Promise<Map<string, Located>> {
  const out = new Map<string, Located>();
  const conversation = numbered(turns);
  const messagesFor = (rubric: Rubric) => (subjectOf(rubric).about === 'customer' ? conversation.customer : conversation.agent);
  const unanswered = (reason: string) => {
    for (const { rubric, raw } of answers) out.set(rubric.id, { raw, turnIndex: null, message: null, probability: null, about: subjectOf(rubric).about, reason });
    return out;
  };
  // A rubric about someone who said nothing has nothing to point at.
  const askable = answers.filter(({ rubric, raw }) => {
    if (messagesFor(rubric).length) return true;
    const about = subjectOf(rubric).about;
    out.set(rubric.id, { raw, turnIndex: null, message: null, probability: null, about, reason: `the ${about} said nothing` });
    return false;
  });
  if (askable.length === 0) return out;
  const state = { conversation: conversation.text, ...fixed };
  const stateTokens = estimateTokens(JSON.stringify(state));

  // Fill each request with as many questions as the 32k budget leaves room for.
  const batches: { rubric: Rubric; raw: string }[][] = [];
  let batch: { rubric: Rubric; raw: string }[] = [];
  let questionTokens = 0;
  for (const answer of askable) {
    const tokens = estimateTokens(JSON.stringify(whichQuestion(answer.rubric, answer.raw, messagesFor(answer.rubric))));
    if (batch.length && stateTokens > stateBudget(questionTokens + tokens)) {
      batches.push(batch);
      batch = [];
      questionTokens = 0;
    }
    batch.push(answer);
    questionTokens += tokens;
  }
  batches.push(batch);
  if (stateTokens > stateBudget(estimateTokens(JSON.stringify(whichQuestion(askable[0].rubric, askable[0].raw, messagesFor(askable[0].rubric)))))) {
    return unanswered('the conversation is too long to point at one message');
  }

  for (const group of batches) {
    const questions: Questions = Object.fromEntries(group.map(({ rubric, raw }) => [questionId(rubric), whichQuestion(rubric, raw, messagesFor(rubric))]));
    const label = group.length === 1 ? `${sessionId} [locate ${group[0].rubric.id}]` : `${sessionId} [locate ${group.length}]`;
    const { answers: picks } = await ask({ stage: 'score', label, state, questions, ledger, sessionId });
    for (const { rubric, raw } of group) {
      out.set(rubric.id, { ...readPick((picks as Record<string, Pick>)[questionId(rubric)], messagesFor(rubric), raw), about: subjectOf(rubric).about });
    }
  }
  return out;
}

/** Which message one answer rests on. */
export async function locate(
  rubric: Rubric,
  raw: string,
  turns: Turn[],
  fixed: FixedState,
  ledger: Ledger,
  sessionId: string,
): Promise<Located> {
  return (await locateAll([{ rubric, raw }], turns, fixed, ledger, sessionId)).get(rubric.id)!;
}

/** Lookups in progress, so opening the same session twice at once asks Jev once. */
const inFlight = new Map<string, Promise<Located>>();

export type LocateOutcome =
  | { status: 200; located: Located & { cached: boolean } }
  | { status: 404 | 409; error: string };

/**
 * Finds which message a stored answer rests on: from what was stored when the
 * answer, the question and the conversation are unchanged, otherwise by asking
 * Jev once — with the conversation as the grader read it, tool calls placed in,
 * instructions and tools alongside.
 */
export async function locateSession(
  store: Pick<Store, 'latestResults' | 'locateFor' | 'saveLocate' | 'sessionRows' | 'tracesFor'>,
  agent: Agent,
  rubric: Rubric,
  sessionId: string,
): Promise<LocateOutcome> {
  const result = store.latestResults([sessionId]).find((row) => row.rubricId === rubric.id);
  if (!result) return { status: 409, error: `"${rubric.name}" has no answer for this session yet` };
  const read = store.sessionRows(agent.id, sessionId).find((row) => row.transcript !== '[]');
  if (!read) return { status: 404, error: 'No conversation stored for this session' };
  const turns = (JSON.parse(read.transcript) as Turn[]).filter((turn) => !turn.tool);
  const key = locateKey(rubric, result.raw, turns);

  const cached = store.locateFor(agent.id, sessionId, rubric.id, key);
  if (cached) return { status: 200, located: { ...cached, cached: true } };

  const flight = `${agent.id}\u0000${sessionId}\u0000${rubric.id}\u0000${key}`;
  let pending = inFlight.get(flight);
  if (!pending) {
    const traces = store.tracesFor(agent.id, sessionId);
    const trace = traces.length ? reconstruct(traces) : undefined;
    pending = locate(rubric, result.raw, withToolLines(turns, trace), fixedState(trace), new LedgerClass(), sessionId)
      .then((located) => {
        const stored = { ...located, key };
        store.saveLocate(agent.id, sessionId, rubric.id, stored);
        return stored;
      })
      .finally(() => inFlight.delete(flight));
    inFlight.set(flight, pending);
  }
  return { status: 200, located: { ...(await pending), cached: false } };
}
