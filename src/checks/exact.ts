/**
 * Stage 0 of grading: what the data proves outright, with no model involved.
 *
 * These cost nothing, never vary between runs, and need no validity check, so
 * anything that can be decided exactly is decided here rather than asked of
 * Jev. Every check reports pass, fail, or unchecked — unchecked is not a pass.
 */
import type { Turn } from '../cognigy/transcript.ts';
import type { CheckResult, SessionTrace, ToolCallRecord } from '../traces/reconstruct.ts';
import { validateArgs } from './schema.ts';

export const CALL_CHECKS = {
  args_parse: 'Arguments are valid JSON',
  known_tool: 'The tool exists',
  schema: 'Arguments match the schema',
  tool_error: 'The tool accepted the call',
  repeat: 'Not a repeat of an earlier call',
  has_result: 'The tool returned a result',
} as const;

/** Status values a tool uses to say it did not do what it was asked. */
const REFUSED = new Set(['error', 'failed', 'failure', 'incomplete', 'rejected', 'invalid', 'denied']);

/** Why a result means the tool refused or failed, or undefined when it looks fine. */
export function toolFailure(record: Pick<ToolCallRecord, 'result' | 'resultJson'>): string | undefined {
  const json = record.resultJson;
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const result = json as Record<string, unknown>;
    const reason = [result.reason, result.message, result.error].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
    if (result.error && result.error !== false) return typeof result.error === 'string' ? result.error : 'the result carries an error';
    if (typeof result.status === 'string' && REFUSED.has(result.status.toLowerCase())) return `status ${result.status}${reason ? `: ${reason}` : ''}`;
    if (result.ok === false || result.success === false) return reason ?? 'the tool reported it did not succeed';
    return undefined;
  }
  if (record.result && /^\s*(error|exception|failed)\b/i.test(record.result)) return record.result.trim().slice(0, 160);
  return undefined;
}

/** Arguments as a stable string, so the same call made twice compares equal whatever the key order. */
function signature(record: ToolCallRecord): string {
  const sorted = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]))
      : value;
  return `${record.name}\u0000${JSON.stringify(sorted(record.args ?? record.argsRaw))}`;
}

/** Fills in each call's checks. The calls must be in session order. */
export function checkToolCalls(records: ToolCallRecord[], tools: SessionTrace['tools']): void {
  const seen = new Map<string, number>();
  for (const record of records) {
    const checks: CheckResult[] = [];
    const definition = record.definition ?? tools.find((tool) => tool.name === record.name);

    if (record.args === null) {
      checks.push({ id: 'args_parse', outcome: 'fail', detail: 'the model wrote arguments that are not a JSON object' });
    } else {
      checks.push({ id: 'args_parse', outcome: 'pass' });
    }

    checks.push(definition
      ? { id: 'known_tool', outcome: 'pass' }
      : { id: 'known_tool', outcome: tools.length ? 'fail' : 'unchecked', detail: tools.length ? `the agent had no tool called ${record.name}` : 'no tool definitions were logged' });

    if (record.args === null || !definition?.parameters) {
      checks.push({ id: 'schema', outcome: 'unchecked', detail: record.args === null ? 'arguments could not be read' : 'the tool has no schema' });
    } else {
      const { issues, unchecked } = validateArgs(record.args, definition.parameters);
      checks.push(issues.length
        ? { id: 'schema', outcome: 'fail', detail: issues.map((issue) => issue.message).join('; ') }
        : { id: 'schema', outcome: 'pass', ...(unchecked.length ? { detail: `not checked: ${unchecked.join(', ')}` } : {}) });
    }

    if (record.result === undefined) {
      checks.push({ id: 'has_result', outcome: 'fail', detail: 'no result was logged for this call' });
      checks.push({ id: 'tool_error', outcome: 'unchecked', detail: 'no result to read' });
    } else {
      checks.push({ id: 'has_result', outcome: 'pass' });
      const failure = toolFailure(record);
      checks.push(failure ? { id: 'tool_error', outcome: 'fail', detail: failure } : { id: 'tool_error', outcome: 'pass' });
    }

    const key = signature(record);
    const first = seen.get(key);
    checks.push(first === undefined
      ? { id: 'repeat', outcome: 'pass' }
      : { id: 'repeat', outcome: 'fail', detail: `the same call as #${first}` });
    if (first === undefined) seen.set(key, record.seq);

    record.checks = checks;
  }
}

export interface SessionChecks {
  /** User message to the agent's first reply, per turn that has both. */
  latency: { turns: number; medianMs?: number; maxMs?: number };
  /** Inputs with a logged LLM call that the transcript doesn't have — a transcript missing turns. */
  transcriptGaps: string[];
  /** Payload fields that arrived shaped unexpectedly, and where. */
  drift: number;
  driftPaths: string[];
  /** Tool calls with at least one failed check. */
  failedCalls: number;
}

export function checkSession(turns: Turn[], trace: SessionTrace | undefined): SessionChecks {
  const waits: number[] = [];
  const firstUser = new Map<string, number>();
  const answered = new Set<string>();
  for (const turn of turns) {
    if (!turn.inputId || !turn.at || turn.tool) continue;
    const at = Date.parse(turn.at);
    if (Number.isNaN(at)) continue;
    if (turn.role === 'user' && !firstUser.has(turn.inputId)) firstUser.set(turn.inputId, at);
    if (turn.role === 'agent' && firstUser.has(turn.inputId) && !answered.has(turn.inputId)) {
      answered.add(turn.inputId);
      waits.push(at - firstUser.get(turn.inputId)!);
    }
  }
  waits.sort((a, b) => a - b);
  const known = new Set(turns.map((turn) => turn.inputId).filter(Boolean));
  return {
    latency: waits.length
      ? { turns: waits.length, medianMs: waits[Math.floor((waits.length - 1) / 2)], maxMs: waits.at(-1) }
      : { turns: 0 },
    transcriptGaps: trace ? [...trace.inputIds].filter((inputId) => !known.has(inputId)) : [],
    drift: trace?.drift.length ?? 0,
    driftPaths: [...new Set(trace?.drift.map((warning) => warning.path) ?? [])],
    failedCalls: trace ? trace.toolCalls.filter((call) => call.checks.some((check) => check.outcome === 'fail')).length : 0,
  };
}
