/**
 * Which agent message a rubric's verdict rests on.
 *
 * Jev answers a rubric for the whole conversation and never says where. So,
 * once there is a verdict, Jev is asked one more question — a choice between
 * the agent's messages, plus "no single message" — about why it gave that
 * answer. The message it picks is what the session view marks; its confidence
 * decides whether to mark anything at all.
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

/** Below this, Jev isn't sure which message it was, and nothing is marked. */
export const LOCATE_CONFIDENCE = 0.5;
const QUESTION_ID = 'which_message';
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
  /** Which agent message, counting from 1, as the session view numbers them. */
  message: number | null;
  confidence: number | null;
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

/** The agent messages in a conversation, as the pointing question numbers them. */
function agentCount(turns: Pick<Turn, 'role'>[]): number {
  return turns.filter((turn) => turn.role === 'agent').length;
}

export function locateKey(rubric: Rubric, raw: string, turns: Pick<Turn, 'role'>[]): string {
  const question = createHash('sha256').update(rubric.question).digest('hex').slice(0, 12);
  return `${raw}|${question}|${agentCount(turns)}`;
}

function opening(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= OPENING_CHARS ? flat : `${flat.slice(0, OPENING_CHARS - 1)}…`;
}

/** The conversation with each agent message numbered, so options can name them. */
function numbered(turns: Turn[]): { text: string; agent: { message: number; turnIndex: number; text: string }[] } {
  const agent: { message: number; turnIndex: number; text: string }[] = [];
  const lines = turns.map((turn, index) => {
    if (turn.role === 'system') return turn.text;
    if (turn.role === 'user') return `Customer: ${turn.text}`;
    agent.push({ message: agent.length + 1, turnIndex: index, text: turn.text });
    return `Agent message ${agent.length}: ${turn.text}`;
  });
  return { text: lines.join('\n'), agent };
}

export function locateQuestion(rubric: Rubric, raw: string, agent: { message: number; text: string }[]): Questions {
  const options: Record<string, string> = {};
  for (const item of agent) options[`message_${item.message}`] = `Agent message ${item.message}: "${opening(item.text)}"`;
  options[NONE] = 'No single message: the answer rests on the conversation as a whole.';
  return {
    [QUESTION_ID]: choice({
      question: `For this conversation, the answer to "${rubric.question}" was ${verdictText(rubric, raw)}. Which agent message is the main reason for that answer?`,
      focus: 'Pick the one agent message the answer rests on most. Pick "none" when no single message decides it.',
    }, options),
  };
}

/**
 * Asks which message a verdict rests on. `turns` are the conversation as the
 * grader read it, tool lines included; `fixed` is the instructions and tools it
 * was given.
 */
export async function locate(
  rubric: Rubric,
  raw: string,
  turns: Turn[],
  fixed: FixedState,
  ledger: Ledger,
  sessionId: string,
): Promise<Located> {
  const { text, agent } = numbered(turns);
  if (agent.length === 0) return { raw, turnIndex: null, message: null, confidence: null, reason: 'the agent said nothing' };
  const questions = locateQuestion(rubric, raw, agent);
  const state = { conversation: text, ...fixed };
  if (estimateTokens(JSON.stringify(state)) > stateBudget(estimateTokens(JSON.stringify(questions)))) {
    return { raw, turnIndex: null, message: null, confidence: null, reason: 'the conversation is too long to point at one message' };
  }

  const { answers } = await ask({ stage: 'score', label: `${sessionId} [locate ${rubric.id}]`, state, questions, ledger, sessionId });
  const answer = (answers as Record<string, { choice?: string; confidence?: number }>)[QUESTION_ID];
  const confidence = answer?.confidence ?? null;
  const picked = answer?.choice?.match(/^message_(\d+)$/);
  if (!picked) return { raw, turnIndex: null, message: null, confidence, reason: 'no single message decides this one' };
  const found = agent.find((item) => item.message === Number(picked[1]));
  if (!found) return { raw, turnIndex: null, message: null, confidence, reason: 'Jev named a message that isn’t there' };
  if (confidence === null || confidence < LOCATE_CONFIDENCE) {
    return { raw, turnIndex: null, message: found.message, confidence, reason: 'Jev isn’t sure which message' };
  }
  return { raw, turnIndex: found.turnIndex, message: found.message, confidence };
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
