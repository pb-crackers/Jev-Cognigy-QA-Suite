/**
 * Local storage, on `node:sqlite` so there is no dependency to install.
 *
 * Raw per-rubric answers are stored and nothing derived is. Weights, polarity
 * and thresholds are applied at read time, which is what lets a weight change
 * re-rank an entire history without re-scoring or re-billing anything.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Rubric } from '../rubrics/model.ts';
import type { Agent } from '../agents/model.ts';
import { traceKey, unwrapTrace, type StoredTrace, type TracePayload } from '../traces/model.ts';
import type { ToolCallRecord } from '../traces/reconstruct.ts';
import type { Located } from '../scoring/locate.ts';
import { databaseFile } from '../paths.ts';

export interface RunRow {
  id: string;
  startedAt: string;
  projectId: string;
  projectName: string;
  endpointLabel: string;
  fromTs: string;
  toTs: string;
  sessions: number;
  costUsd: number;
  ms: number;
  /** The agent this run collected for; absent for an ad-hoc run. */
  agentId?: string | null;
}

export interface SessionRow {
  runId: string;
  sessionId: string;
  startedAt: string;
  endpointLabel: string;
  channel: string | null;
  /** The readable label at the time of the run; the raw value above is the fact. */
  channelLabel: string | null;
  flowName: string | null;
  turns: number;
  chunks: number;
  rating: number | null;
  ratingComment: string | null;
  unscoreable: string | null;
  transcript: string;
  costUsd: number;
  ms: number;
  /** When the session's newest record was written, so growth after scoring is seen. */
  lastAt?: string | null;
  /** How much of the session's agent output has a logged LLM call behind it. */
  traceCoverage?: TraceCoverage | null;
  /** Why scoring failed, when it did. A failed session has no results and is retried. */
  error?: string | null;
  /** Consecutive failed attempts, including this one. */
  attempts?: number | null;
  /** Stage-0 checks for the session, as JSON (`SessionChecks`). */
  checks?: string | null;
}

/** A session row as stored — one mapping, however it was queried. */
function sessionRow(row: Record<string, never>): SessionRow {
  return {
    runId: row.run_id, sessionId: row.session_id, startedAt: row.started_at,
    endpointLabel: row.endpoint_label, channel: row.channel,
    channelLabel: row.channel_label, flowName: row.flow_name,
    turns: row.turns, chunks: row.chunks, rating: row.rating,
    ratingComment: row.rating_comment, unscoreable: row.unscoreable,
    transcript: row.transcript, costUsd: row.cost_usd, ms: row.ms,
    lastAt: row.last_at ?? null, traceCoverage: row.trace_coverage ?? null,
    error: row.error ?? null, attempts: row.attempts ?? null, checks: row.checks ?? null,
  };
}

export type TraceCoverage = 'full' | 'partial' | 'none';

/** Where the collector has got to for one agent. */
export interface AgentState {
  agentId: string;
  /** Everything settled before this instant has been collected. */
  watermark: string | null;
  lastCollectedAt: string | null;
  lastError: string | null;
}

export interface AlertRow {
  id: number;
  agentId: string;
  rubricId: string;
  /** The window the alert belongs to, keyed on conversation time: `day:2026-09-22`. */
  windowKey: string;
  happenedAt: string;
  detectedAt: string;
  count: number;
  sessions: string[];
  /** What happened to each delivery: `ok`, `off`, or the error. */
  delivered: Record<string, string>;
}

export interface ResultRow {
  runId: string;
  sessionId: string;
  rubricId: string;
  raw: string;
  confidence: number | null;
  chunks: number;
  decidedBy: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rubric (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, project_id TEXT NOT NULL,
  project_name TEXT NOT NULL, endpoint_label TEXT NOT NULL,
  from_ts TEXT NOT NULL, to_ts TEXT NOT NULL,
  sessions INTEGER NOT NULL, cost_usd REAL NOT NULL, ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  run_id TEXT NOT NULL, session_id TEXT NOT NULL, started_at TEXT NOT NULL,
  endpoint_label TEXT NOT NULL, channel TEXT, channel_label TEXT, flow_name TEXT,
  turns INTEGER NOT NULL, chunks INTEGER NOT NULL,
  rating INTEGER, rating_comment TEXT, unscoreable TEXT,
  transcript TEXT NOT NULL, cost_usd REAL NOT NULL, ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, session_id)
);
CREATE TABLE IF NOT EXISTS result (
  run_id TEXT NOT NULL, session_id TEXT NOT NULL, rubric_id TEXT NOT NULL,
  raw TEXT NOT NULL, confidence REAL, chunks INTEGER NOT NULL, decided_by INTEGER,
  PRIMARY KEY (run_id, session_id, rubric_id)
);
CREATE INDEX IF NOT EXISTS result_by_run ON result (run_id);
CREATE INDEX IF NOT EXISTS result_by_session ON result (session_id, rubric_id);
CREATE TABLE IF NOT EXISTS agent (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_state (
  agent_id TEXT PRIMARY KEY, watermark TEXT, last_collected_at TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL, session_id TEXT NOT NULL, input_id TEXT,
  event_at TEXT NOT NULL, received_at TEXT NOT NULL, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trace_by_session ON trace (agent_id, session_id);
CREATE TABLE IF NOT EXISTS alert (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL, rubric_id TEXT NOT NULL, window_key TEXT NOT NULL,
  happened_at TEXT NOT NULL, detected_at TEXT NOT NULL, count INTEGER NOT NULL,
  sessions TEXT NOT NULL, delivered TEXT NOT NULL,
  UNIQUE (agent_id, rubric_id, window_key)
);
CREATE TABLE IF NOT EXISTS validity (
  rubric_id TEXT PRIMARY KEY, json TEXT NOT NULL, computed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coverage (
  agent_id TEXT PRIMARY KEY, json TEXT NOT NULL, computed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locate (
  agent_id TEXT NOT NULL, session_id TEXT NOT NULL, rubric_id TEXT NOT NULL,
  json TEXT NOT NULL, located_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_id, rubric_id)
);
CREATE TABLE IF NOT EXISTS tool_call (
  agent_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  name TEXT NOT NULL, input_id TEXT, json TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_id, seq)
);
`;

/** Bumped whenever `traceKey` changes, so stored calls are keyed afresh. */
const TRACE_KEY_VERSION = '2';

export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string = databaseFile()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  /**
   * Columns added after a database already exists. `CREATE TABLE IF NOT EXISTS`
   * leaves an existing table alone, so a new column has to be added explicitly;
   * SQLite has no `ADD COLUMN IF NOT EXISTS`, hence the check against the
   * table's own schema.
   */
  #migrate(): void {
    const has = (table: string, column: string) =>
      (this.#db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
        (row) => row.name === column,
      );
    const add = (table: string, column: string, type: string) => {
      if (!has(table, column)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    };
    add('session', 'channel_label', 'TEXT');
    add('session', 'last_at', 'TEXT');
    add('session', 'trace_coverage', 'TEXT');
    add('run', 'agent_id', 'TEXT');
    add('session', 'error', 'TEXT');
    add('session', 'attempts', 'INTEGER');
    add('session', 'checks', 'TEXT');
    // Collections that found nothing used to be recorded as runs; they only buried the real ones.
    this.#db.exec('DELETE FROM run WHERE agent_id IS NOT NULL AND sessions = 0 AND id NOT IN (SELECT run_id FROM session)');

    // Each logged call is stored once, however often it is delivered (see
    // `traceKey`). Existing rows are keyed afresh whenever the key changes, in
    // one transaction: a half-keyed table would dedupe some calls and not others.
    if (!has('trace', 'trace_id')) this.#db.exec('ALTER TABLE trace ADD COLUMN trace_id TEXT');
    const keyed = this.#db.prepare("SELECT value FROM meta WHERE key = 'trace_key'").get() as { value: string } | undefined;
    if (keyed?.value !== TRACE_KEY_VERSION) {
      this.#db.exec('BEGIN');
      try {
        this.#db.exec('DROP INDEX IF EXISTS trace_once');
        const update = this.#db.prepare('UPDATE trace SET trace_id = ? WHERE id = ?');
        for (const row of this.#db.prepare('SELECT id, json FROM trace').all() as { id: number; json: string }[]) {
          const payload = unwrapTrace(JSON.parse(row.json));
          update.run(payload ? traceKey(payload) : `unreadable|${row.id}`, row.id);
        }
        this.#db.exec('DELETE FROM trace WHERE id NOT IN (SELECT MIN(id) FROM trace GROUP BY agent_id, trace_id)');
        this.#db.exec('CREATE UNIQUE INDEX trace_once ON trace (agent_id, trace_id)');
        this.#db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('trace_key', ?)").run(TRACE_KEY_VERSION);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  close(): void {
    this.#db.close();
  }

  // ---- rubrics ----

  rubrics(): Rubric[] {
    const rows = this.#db.prepare('SELECT json FROM rubric ORDER BY position, id').all() as {
      json: string;
    }[];
    return rows.map((row) => JSON.parse(row.json) as Rubric);
  }

  saveRubric(rubric: Rubric, position?: number): void {
    this.#db
      .prepare(
        `INSERT INTO rubric (id, json, position) VALUES (?, ?, COALESCE(?, 0))
         ON CONFLICT(id) DO UPDATE SET json = excluded.json,
           position = COALESCE(excluded.position, rubric.position)`,
      )
      .run(rubric.id, JSON.stringify(rubric), position ?? null);
  }

  deleteRubric(id: string): void {
    this.#db.prepare('DELETE FROM rubric WHERE id = ?').run(id);
  }

  /** Seeds the starter set, but only into an empty library. */
  seedRubrics(rubrics: Rubric[]): boolean {
    if (this.rubrics().length > 0) return false;
    rubrics.forEach((rubric, index) => this.saveRubric(rubric, index));
    return true;
  }

  /**
   * Adds shipped library rubrics this database has never been given.
   *
   * Each is added once. One the user deleted stays deleted, and one the user
   * edited keeps their wording — a library rubric is a starting point, not
   * something the tool reasserts on every start. Starter rubrics stored before
   * `origin` existed are marked as library ones, which is what they are.
   */
  /**
   * Gives stored copies of shipped rubrics a field added to them later, where
   * the copy has never had it. A value someone chose — even the default — is
   * left alone.
   */
  fillShippedFields(shipped: Rubric[], fields: (keyof Rubric)[]): void {
    const stored = new Map(this.rubrics().map((rubric) => [rubric.id, rubric]));
    for (const definition of shipped) {
      const copy = stored.get(definition.id);
      if (!copy || copy.origin !== 'library') continue;
      const missing = fields.filter((field) => copy[field] === undefined && definition[field] !== undefined);
      if (missing.length) this.saveRubric({ ...copy, ...Object.fromEntries(missing.map((field) => [field, definition[field]])) });
    }
  }

  seedLibrary(library: Rubric[], shippedIds: Iterable<string>): string[] {
    const seeded = new Set<string>(JSON.parse(this.getMeta('library_seeded') ?? '[]') as string[]);
    const existing = new Map(this.rubrics().map((rubric) => [rubric.id, rubric]));
    const shipped = new Set(shippedIds);
    const added: string[] = [];

    for (const [id, rubric] of existing) {
      if (shipped.has(id) && !rubric.origin) this.saveRubric({ ...rubric, origin: 'library' });
    }
    let position = existing.size;
    for (const rubric of library) {
      if (seeded.has(rubric.id)) continue;
      seeded.add(rubric.id);
      if (existing.has(rubric.id)) continue;
      this.saveRubric(rubric, position++);
      added.push(rubric.id);
    }
    this.setMeta('library_seeded', JSON.stringify([...seeded]));
    return added;
  }

  getMeta(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // ---- runs ----

  saveRun(run: RunRow): void {
    this.#db
      .prepare(
        `INSERT INTO run (id, started_at, project_id, project_name, endpoint_label,
           from_ts, to_ts, sessions, cost_usd, ms, agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sessions = excluded.sessions,
           cost_usd = excluded.cost_usd, ms = excluded.ms`,
      )
      .run(
        run.id, run.startedAt, run.projectId, run.projectName, run.endpointLabel,
        run.fromTs, run.toTs, run.sessions, run.costUsd, run.ms, run.agentId ?? null,
      );
  }

  runs(): RunRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM run ORDER BY started_at DESC LIMIT 50')
      .all() as Record<string, never>[];
    return rows.map((row) => ({
      id: row.id, startedAt: row.started_at, projectId: row.project_id,
      projectName: row.project_name, endpointLabel: row.endpoint_label,
      fromTs: row.from_ts, toTs: row.to_ts, sessions: row.sessions,
      costUsd: row.cost_usd, ms: row.ms, agentId: row.agent_id ?? null,
    }));
  }

  // ---- sessions and results ----

  saveSession(session: SessionRow, results: ResultRow[]): void {
    this.#db
      .prepare(
        `INSERT INTO session (run_id, session_id, started_at, endpoint_label, channel,
           channel_label, flow_name, turns, chunks, rating, rating_comment, unscoreable,
           transcript, cost_usd, ms, last_at, trace_coverage, error, attempts, checks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, session_id) DO UPDATE SET
           turns = excluded.turns, chunks = excluded.chunks,
           transcript = excluded.transcript, cost_usd = excluded.cost_usd, ms = excluded.ms,
           last_at = excluded.last_at, trace_coverage = excluded.trace_coverage,
           error = excluded.error, attempts = excluded.attempts, checks = excluded.checks`,
      )
      .run(
        session.runId, session.sessionId, session.startedAt, session.endpointLabel,
        session.channel, session.channelLabel ?? null, session.flowName,
        session.turns, session.chunks,
        session.rating, session.ratingComment, session.unscoreable,
        session.transcript, session.costUsd, session.ms,
        session.lastAt ?? null, session.traceCoverage ?? null,
        session.error ?? null, session.attempts ?? null, session.checks ?? null,
      );

    const insert = this.#db.prepare(
      `INSERT INTO result (run_id, session_id, rubric_id, raw, confidence, chunks, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, session_id, rubric_id) DO UPDATE SET
         raw = excluded.raw, confidence = excluded.confidence,
         chunks = excluded.chunks, decided_by = excluded.decided_by`,
    );
    for (const result of results) {
      insert.run(
        result.runId, result.sessionId, result.rubricId, result.raw,
        result.confidence, result.chunks, result.decidedBy,
      );
    }
  }

  sessionsForRun(runId: string): SessionRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM session WHERE run_id = ? ORDER BY started_at DESC')
      .all(runId) as Record<string, never>[];
    return rows.map(sessionRow);
  }

  resultsForRun(runId: string): ResultRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM result WHERE run_id = ?')
      .all(runId) as Record<string, never>[];
    return rows.map((row) => ({
      runId: row.run_id, sessionId: row.session_id, rubricId: row.rubric_id,
      raw: row.raw, confidence: row.confidence, chunks: row.chunks,
      decidedBy: row.decided_by,
    }));
  }

  /** Session ids already scored for a project, so a run can skip them. */
  alreadyScored(projectId: string): Set<string> {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT s.session_id FROM session s
         JOIN run r ON r.id = s.run_id WHERE r.project_id = ? AND s.error IS NULL`,
      )
      .all(projectId) as { session_id: string }[];
    return new Set(rows.map((row) => row.session_id));
  }

  /**
   * Which rubrics each session has already been answered on, across every run,
   * and when the session was last seen.
   *
   * An agent grades against its own rubric set, which is rarely the set an
   * ad-hoc run used. Skipping by session alone would leave an agent's rubrics
   * unanswered on any session someone had scored before, so an agent run skips
   * per session × rubric instead.
   */
  scoredRubrics(sessionIds: string[]): Map<string, { rubrics: Set<string>; lastAt: string | null }> {
    const out = new Map<string, { rubrics: Set<string>; lastAt: string | null }>();
    if (sessionIds.length === 0) return out;
    const marks = sessionIds.map(() => '?').join(',');
    const rows = this.#db
      .prepare(
        `SELECT r.session_id, r.rubric_id, s.last_at FROM result r
         JOIN session s ON s.run_id = r.run_id AND s.session_id = r.session_id
         WHERE r.session_id IN (${marks})`,
      )
      .all(...sessionIds) as { session_id: string; rubric_id: string; last_at: string | null }[];
    for (const row of rows) {
      const entry = out.get(row.session_id) ?? { rubrics: new Set<string>(), lastAt: null };
      entry.rubrics.add(row.rubric_id);
      if (row.last_at && (!entry.lastAt || row.last_at > entry.lastAt)) entry.lastAt = row.last_at;
      out.set(row.session_id, entry);
    }
    return out;
  }

  /**
   * The newest answer for every (session, rubric), merged across runs.
   *
   * One session's answers can be spread over several runs — an ad-hoc run that
   * answered nine rubrics, then an agent run that answered the one it was
   * missing. Health reads them as one set.
   */
  latestResults(sessionIds: string[]): ResultRow[] {
    if (sessionIds.length === 0) return [];
    const marks = sessionIds.map(() => '?').join(',');
    const rows = this.#db
      .prepare(
        `SELECT r.* FROM result r
         JOIN run ru ON ru.id = r.run_id
         WHERE r.session_id IN (${marks})
         ORDER BY ru.started_at ASC`,
      )
      .all(...sessionIds) as Record<string, never>[];
    const latest = new Map<string, ResultRow>();
    for (const row of rows) {
      latest.set(`${row.session_id}\u0000${row.rubric_id}`, {
        runId: row.run_id, sessionId: row.session_id, rubricId: row.rubric_id,
        raw: row.raw, confidence: row.confidence, chunks: row.chunks, decidedBy: row.decided_by,
      });
    }
    return [...latest.values()];
  }

  /** The newest stored row for each session an agent has collected. */
  agentSessions(agentId: string, since?: string): SessionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM session s JOIN run r ON r.id = s.run_id
         WHERE r.agent_id = ? ${since ? 'AND s.started_at >= ?' : ''}
         ORDER BY r.started_at ASC, s.rowid ASC`,
      )
      .all(...(since ? [agentId, since] : [agentId])) as Record<string, never>[];
    const newest = new Map<string, SessionRow>();
    for (const row of rows) {
      newest.set(row.session_id, sessionRow(row));
    }
    return [...newest.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // ---- traces ----

  /** Stores a logged call once. Returns false when it was already stored. */
  saveTrace(agentId: string, payload: TracePayload, receivedAt = new Date().toISOString()): boolean {
    const { sessionId, inputId, timestamp } = payload.meta;
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO trace (agent_id, session_id, input_id, event_at, received_at, json, trace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agentId, sessionId, inputId ?? null, timestamp, receivedAt, JSON.stringify(payload), traceKey(payload),
      );
    return result.changes > 0;
  }

  // ---- tool calls ----

  /** Replaces a session's tool call records with the ones just rebuilt. */
  saveToolCalls(agentId: string, sessionId: string, calls: ToolCallRecord[]): void {
    this.#db.prepare('DELETE FROM tool_call WHERE agent_id = ? AND session_id = ?').run(agentId, sessionId);
    const insert = this.#db.prepare(
      'INSERT INTO tool_call (agent_id, session_id, seq, name, input_id, json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const call of calls) insert.run(agentId, sessionId, call.seq, call.name, call.inputId ?? null, JSON.stringify(call));
  }

  // ---- which message a verdict rests on ----

  saveLocate(agentId: string, sessionId: string, rubricId: string, located: Located): void {
    this.#db
      .prepare(
        `INSERT INTO locate (agent_id, session_id, rubric_id, json, located_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, session_id, rubric_id) DO UPDATE SET json = excluded.json, located_at = excluded.located_at`,
      )
      .run(agentId, sessionId, rubricId, JSON.stringify(located), new Date().toISOString());
  }

  /** The stored answer, if it was asked about this same answer, question and conversation (see `locateKey`). */
  locateFor(agentId: string, sessionId: string, rubricId: string, key: string): Located | undefined {
    const row = this.#db
      .prepare('SELECT json FROM locate WHERE agent_id = ? AND session_id = ? AND rubric_id = ?')
      .get(agentId, sessionId, rubricId) as { json: string } | undefined;
    const located = row ? (JSON.parse(row.json) as Located) : undefined;
    return located?.key === key ? located : undefined;
  }

  /** Every stored answer for one rubric under an agent, by session. */
  locatesForRubric(agentId: string, rubricId: string): Map<string, Located> {
    const rows = this.#db
      .prepare('SELECT session_id, json FROM locate WHERE agent_id = ? AND rubric_id = ?')
      .all(agentId, rubricId) as { session_id: string; json: string }[];
    return new Map(rows.map((row) => [row.session_id, JSON.parse(row.json) as Located]));
  }

  /** Records a session's stage-0 checks after the fact, without touching its scores. */
  setSessionChecks(runId: string, sessionId: string, checks: string): void {
    this.#db.prepare('UPDATE session SET checks = ? WHERE run_id = ? AND session_id = ?').run(checks, runId, sessionId);
  }

  toolCallsFor(agentId: string, sessionId: string): ToolCallRecord[] {
    const rows = this.#db
      .prepare('SELECT json FROM tool_call WHERE agent_id = ? AND session_id = ? ORDER BY seq')
      .all(agentId, sessionId) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as ToolCallRecord);
  }

  /**
   * Sessions whose newest attempt under this agent failed, with how many times
   * in a row it has — what the collector retries.
   */
  failedSessions(agentId: string): { sessionId: string; attempts: number; error: string }[] {
    return this.#newest(agentId, 'error IS NOT NULL')
      .map((session) => ({ sessionId: session.sessionId, attempts: session.attempts ?? 1, error: session.error! }));
  }

  /** Sessions whose newest row has no stage-0 checks yet — scored before checks existed. */
  sessionsWithoutChecks(agentId: string): SessionRow[] {
    return this.#newest(agentId, 'checks IS NULL AND error IS NULL');
  }

  /** Every row an agent has for one session, newest first. */
  sessionRows(agentId: string, sessionId: string): SessionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM session s JOIN run r ON r.id = s.run_id
         WHERE r.agent_id = ? AND s.session_id = ? ORDER BY r.started_at DESC, s.rowid DESC`,
      )
      .all(agentId, sessionId) as Record<string, never>[];
    return rows.map(sessionRow);
  }

  /** Each session's newest row under an agent, narrowed by a condition on that row. */
  #newest(agentId: string, where: string): SessionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM (
           SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.session_id ORDER BY r.started_at DESC, s.rowid DESC) AS newest
           FROM session s JOIN run r ON r.id = s.run_id WHERE r.agent_id = ?
         ) WHERE newest = 1 AND ${where}`,
      )
      .all(agentId) as Record<string, never>[];
    return rows.map(sessionRow);
  }

  tracesFor(agentId: string, sessionId: string): StoredTrace[] {
    const rows = this.#db
      .prepare('SELECT * FROM trace WHERE agent_id = ? AND session_id = ? ORDER BY event_at, id')
      .all(agentId, sessionId) as Record<string, never>[];
    return rows.map((row) => ({
      id: row.id, agentId: row.agent_id, sessionId: row.session_id, inputId: row.input_id,
      eventAt: row.event_at, receivedAt: row.received_at, payload: JSON.parse(row.json) as TracePayload,
    }));
  }

  /** How many traces an agent has received, and when the newest arrived. */
  traceSummary(agentId: string): { traces: number; sessions: number; lastReceivedAt: string | null } {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS traces, COUNT(DISTINCT session_id) AS sessions, MAX(received_at) AS last
         FROM trace WHERE agent_id = ?`,
      )
      .get(agentId) as { traces: number; sessions: number; last: string | null };
    return { traces: row.traces, sessions: row.sessions, lastReceivedAt: row.last };
  }

  /** The newest trace an agent has received — where its current instructions are read from. */
  latestTrace(agentId: string): StoredTrace | undefined {
    const row = this.#db
      .prepare('SELECT * FROM trace WHERE agent_id = ? ORDER BY event_at DESC, id DESC LIMIT 1')
      .get(agentId) as Record<string, never> | undefined;
    if (!row) return undefined;
    return {
      id: row.id, agentId: row.agent_id, sessionId: row.session_id, inputId: row.input_id,
      eventAt: row.event_at, receivedAt: row.received_at, payload: JSON.parse(row.json) as TracePayload,
    };
  }

  // ---- validity and coverage ----

  /** The newest answer per session for one rubric, across every run. */
  resultsForRubric(rubricId: string): ResultRow[] {
    const rows = this.#db
      .prepare(
        `SELECT r.* FROM result r JOIN run ru ON ru.id = r.run_id
         WHERE r.rubric_id = ? ORDER BY ru.started_at ASC`,
      )
      .all(rubricId) as Record<string, never>[];
    const latest = new Map<string, ResultRow>();
    for (const row of rows) {
      latest.set(row.session_id, {
        runId: row.run_id, sessionId: row.session_id, rubricId: row.rubric_id, raw: row.raw,
        confidence: row.confidence, chunks: row.chunks, decidedBy: row.decided_by,
      });
    }
    return [...latest.values()];
  }

  /** Recent single-chunk scored sessions with the agent they were collected for, for re-asking. */
  recentSessions(limit: number): (SessionRow & { agentId: string | null })[] {
    const rows = this.#db
      .prepare(
        `SELECT s.*, r.agent_id AS run_agent_id FROM session s JOIN run r ON r.id = s.run_id
         WHERE s.unscoreable IS NULL AND s.chunks = 1
         ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(Math.max(limit * 4, limit)) as Record<string, never>[];
    const seen = new Set<string>();
    const out: (SessionRow & { agentId: string | null })[] = [];
    for (const row of rows) {
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      out.push({
        ...sessionRow(row),
        agentId: row.run_agent_id ?? null,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  saveValidity(rubricId: string, report: unknown, computedAt: string): void {
    this.#db
      .prepare(
        `INSERT INTO validity (rubric_id, json, computed_at) VALUES (?, ?, ?)
         ON CONFLICT(rubric_id) DO UPDATE SET json = excluded.json, computed_at = excluded.computed_at`,
      )
      .run(rubricId, JSON.stringify(report), computedAt);
  }

  validityReports<T>(): Map<string, T> {
    const rows = this.#db.prepare('SELECT rubric_id, json FROM validity').all() as { rubric_id: string; json: string }[];
    return new Map(rows.map((row) => [row.rubric_id, JSON.parse(row.json) as T]));
  }

  saveCoverage(agentId: string, report: unknown, computedAt: string): void {
    this.#db
      .prepare(
        `INSERT INTO coverage (agent_id, json, computed_at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET json = excluded.json, computed_at = excluded.computed_at`,
      )
      .run(agentId, JSON.stringify(report), computedAt);
  }

  coverageFor<T>(agentId: string): T | undefined {
    const row = this.#db.prepare('SELECT json FROM coverage WHERE agent_id = ?').get(agentId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  // ---- alerts ----

  alertFor(agentId: string, rubricId: string, windowKey: string): AlertRow | undefined {
    const row = this.#db
      .prepare('SELECT * FROM alert WHERE agent_id = ? AND rubric_id = ? AND window_key = ?')
      .get(agentId, rubricId, windowKey) as Record<string, never> | undefined;
    return row ? alertRow(row) : undefined;
  }

  insertAlert(alert: Omit<AlertRow, 'id'>): AlertRow {
    const result = this.#db
      .prepare(
        `INSERT INTO alert (agent_id, rubric_id, window_key, happened_at, detected_at, count, sessions, delivered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.agentId, alert.rubricId, alert.windowKey, alert.happenedAt, alert.detectedAt,
        alert.count, JSON.stringify(alert.sessions), JSON.stringify(alert.delivered),
      );
    return { ...alert, id: Number(result.lastInsertRowid) };
  }

  updateAlert(id: number, change: { count?: number; sessions?: string[]; delivered?: Record<string, string> }): void {
    const current = this.#db.prepare('SELECT * FROM alert WHERE id = ?').get(id) as Record<string, never> | undefined;
    if (!current) return;
    const row = alertRow(current);
    this.#db
      .prepare('UPDATE alert SET count = ?, sessions = ?, delivered = ? WHERE id = ?')
      .run(
        change.count ?? row.count,
        JSON.stringify(change.sessions ?? row.sessions),
        JSON.stringify(change.delivered ?? row.delivered),
        id,
      );
  }

  alerts(filter: { agentId?: string; since?: string; limit?: number } = {}): AlertRow[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.agentId) { clauses.push('agent_id = ?'); args.push(filter.agentId); }
    if (filter.since) { clauses.push('happened_at >= ?'); args.push(filter.since); }
    const rows = this.#db
      .prepare(
        `SELECT * FROM alert ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY happened_at DESC LIMIT ${Math.max(1, Math.min(filter.limit ?? 200, 1000))}`,
      )
      .all(...args) as Record<string, never>[];
    return rows.map(alertRow);
  }

  /** Whether an agent run has recorded this session — what puts it in the agent's health and alerts. */
  agentHasSession(agentId: string, sessionId: string): boolean {
    return Boolean(this.#db
      .prepare('SELECT 1 FROM session s JOIN run r ON r.id = s.run_id WHERE r.agent_id = ? AND s.session_id = ? LIMIT 1')
      .get(agentId, sessionId));
  }

  // ---- agents ----

  agents(): Agent[] {
    const rows = this.#db.prepare('SELECT json FROM agent ORDER BY id').all() as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as Agent);
  }

  agent(id: string): Agent | undefined {
    const row = this.#db.prepare('SELECT json FROM agent WHERE id = ?').get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Agent) : undefined;
  }

  saveAgent(agent: Agent): void {
    this.#db
      .prepare('INSERT INTO agent (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(agent.id, JSON.stringify(agent));
  }

  /**
   * Removes the definition and where its collector had got to. Scored sessions
   * stay: they belong to runs, and a run is history, not configuration.
   */
  deleteAgent(id: string): void {
    this.#db.prepare('DELETE FROM agent WHERE id = ?').run(id);
    this.#db.prepare('DELETE FROM agent_state WHERE agent_id = ?').run(id);
  }

  agentState(agentId: string): AgentState {
    const row = this.#db.prepare('SELECT * FROM agent_state WHERE agent_id = ?').get(agentId) as
      | Record<string, string | null>
      | undefined;
    return {
      agentId,
      watermark: row?.watermark ?? null,
      lastCollectedAt: row?.last_collected_at ?? null,
      lastError: row?.last_error ?? null,
    };
  }

  saveAgentState(state: AgentState): void {
    this.#db
      .prepare(
        `INSERT INTO agent_state (agent_id, watermark, last_collected_at, last_error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET watermark = excluded.watermark,
           last_collected_at = excluded.last_collected_at, last_error = excluded.last_error`,
      )
      .run(state.agentId, state.watermark, state.lastCollectedAt, state.lastError);
  }
}

function alertRow(row: Record<string, never>): AlertRow {
  return {
    id: row.id, agentId: row.agent_id, rubricId: row.rubric_id, windowKey: row.window_key,
    happenedAt: row.happened_at, detectedAt: row.detected_at, count: row.count,
    sessions: JSON.parse(row.sessions) as string[], delivered: JSON.parse(row.delivered) as Record<string, string>,
  };
}
