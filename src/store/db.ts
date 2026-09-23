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
import type { StoredTrace, TracePayload } from '../traces/model.ts';
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
`;

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
           transcript, cost_usd, ms, last_at, trace_coverage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, session_id) DO UPDATE SET
           turns = excluded.turns, chunks = excluded.chunks,
           transcript = excluded.transcript, cost_usd = excluded.cost_usd, ms = excluded.ms,
           last_at = excluded.last_at, trace_coverage = excluded.trace_coverage`,
      )
      .run(
        session.runId, session.sessionId, session.startedAt, session.endpointLabel,
        session.channel, session.channelLabel ?? null, session.flowName,
        session.turns, session.chunks,
        session.rating, session.ratingComment, session.unscoreable,
        session.transcript, session.costUsd, session.ms,
        session.lastAt ?? null, session.traceCoverage ?? null,
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
    return rows.map((row) => ({
      runId: row.run_id, sessionId: row.session_id, startedAt: row.started_at,
      endpointLabel: row.endpoint_label, channel: row.channel,
      channelLabel: row.channel_label, flowName: row.flow_name,
      turns: row.turns, chunks: row.chunks, rating: row.rating,
      ratingComment: row.rating_comment, unscoreable: row.unscoreable,
      transcript: row.transcript, costUsd: row.cost_usd, ms: row.ms,
      lastAt: row.last_at ?? null, traceCoverage: row.trace_coverage ?? null,
    }));
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
         JOIN run r ON r.id = s.run_id WHERE r.project_id = ?`,
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
         ORDER BY r.started_at ASC`,
      )
      .all(...(since ? [agentId, since] : [agentId])) as Record<string, never>[];
    const newest = new Map<string, SessionRow>();
    for (const row of rows) {
      newest.set(row.session_id, {
        runId: row.run_id, sessionId: row.session_id, startedAt: row.started_at,
        endpointLabel: row.endpoint_label, channel: row.channel,
        channelLabel: row.channel_label, flowName: row.flow_name,
        turns: row.turns, chunks: row.chunks, rating: row.rating,
        ratingComment: row.rating_comment, unscoreable: row.unscoreable,
        transcript: row.transcript, costUsd: row.cost_usd, ms: row.ms,
        lastAt: row.last_at ?? null, traceCoverage: row.trace_coverage ?? null,
      });
    }
    return [...newest.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // ---- traces ----

  saveTrace(agentId: string, payload: TracePayload, receivedAt = new Date().toISOString()): number {
    const result = this.#db
      .prepare(
        `INSERT INTO trace (agent_id, session_id, input_id, event_at, received_at, json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agentId, payload.meta.sessionId, payload.meta.inputId ?? null,
        payload.meta.timestamp, receivedAt, JSON.stringify(payload),
      );
    return Number(result.lastInsertRowid);
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
