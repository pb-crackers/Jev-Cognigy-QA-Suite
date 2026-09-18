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
}

export interface SessionRow {
  runId: string;
  sessionId: string;
  startedAt: string;
  endpointLabel: string;
  channel: string | null;
  flowName: string | null;
  turns: number;
  chunks: number;
  rating: number | null;
  ratingComment: string | null;
  unscoreable: string | null;
  transcript: string;
  costUsd: number;
  ms: number;
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
  endpoint_label TEXT NOT NULL, channel TEXT, flow_name TEXT,
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
`;

export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string = databaseFile()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
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

  // ---- runs ----

  saveRun(run: RunRow): void {
    this.#db
      .prepare(
        `INSERT INTO run (id, started_at, project_id, project_name, endpoint_label,
           from_ts, to_ts, sessions, cost_usd, ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sessions = excluded.sessions,
           cost_usd = excluded.cost_usd, ms = excluded.ms`,
      )
      .run(
        run.id, run.startedAt, run.projectId, run.projectName, run.endpointLabel,
        run.fromTs, run.toTs, run.sessions, run.costUsd, run.ms,
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
      costUsd: row.cost_usd, ms: row.ms,
    }));
  }

  // ---- sessions and results ----

  saveSession(session: SessionRow, results: ResultRow[]): void {
    this.#db
      .prepare(
        `INSERT INTO session (run_id, session_id, started_at, endpoint_label, channel,
           flow_name, turns, chunks, rating, rating_comment, unscoreable, transcript,
           cost_usd, ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, session_id) DO UPDATE SET
           turns = excluded.turns, chunks = excluded.chunks,
           transcript = excluded.transcript, cost_usd = excluded.cost_usd, ms = excluded.ms`,
      )
      .run(
        session.runId, session.sessionId, session.startedAt, session.endpointLabel,
        session.channel, session.flowName, session.turns, session.chunks,
        session.rating, session.ratingComment, session.unscoreable,
        session.transcript, session.costUsd, session.ms,
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
      endpointLabel: row.endpoint_label, channel: row.channel, flowName: row.flow_name,
      turns: row.turns, chunks: row.chunks, rating: row.rating,
      ratingComment: row.rating_comment, unscoreable: row.unscoreable,
      transcript: row.transcript, costUsd: row.cost_usd, ms: row.ms,
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
}
