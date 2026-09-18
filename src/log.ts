/**
 * Append-only JSONL log of every model call: the request we sent and the answers
 * we got, with tokens, latency and cost. This is the raw evidence behind the
 * metrics panel, so it records the full payload rather than a summary.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallRecord } from './metering.ts';

const LOG_DIR = 'logs';

export interface LogEntry extends CallRecord {
  ts: string;
  sessionId: string;
  request: unknown;
  response: unknown;
}

let ready: Promise<void> | undefined;

function logPath(): string {
  return join(LOG_DIR, `calls-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

/**
 * Logging must never take down a turn, so a write failure is reported and
 * swallowed rather than thrown — but it is never silent.
 */
export async function logCall(entry: LogEntry): Promise<void> {
  ready ??= mkdir(LOG_DIR, { recursive: true }).then(() => undefined);
  try {
    await ready;
    await appendFile(logPath(), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('[log] could not write call log:', error);
  }
}
