/**
 * The loop that makes Agent Watch a monitor rather than a tool you run.
 *
 * It lives in the same process as the web UI and the webhook receiver, so one
 * background process — kept alive by launchd — does all three. Every minute it
 * collects any enabled agent that is due, one at a time: Cognigy's OData allows
 * four concurrent requests per project, and collections are cheap enough that
 * running them in series costs nothing that matters.
 *
 * An agent with a backlog — a catch-up bigger than one batch — is due again on
 * the next tick instead of waiting a whole interval.
 */
import type { Agent } from '../agents/model.ts';
import type { AgentState } from '../store/db.ts';
import { collectAgent, type CollectDeps, type CollectReport } from './collect.ts';

export const TICK_MS = 60_000;

export function isDue(agent: Agent, state: AgentState, now: Date, backlog: boolean): boolean {
  if (!agent.enabled) return false;
  if (backlog || !state.lastCollectedAt) return true;
  return now.getTime() - Date.parse(state.lastCollectedAt) >= agent.intervalMinutes * 60_000;
}

export class Scheduler {
  readonly #deps: CollectDeps;
  readonly #onReport: (report: CollectReport) => void;
  readonly #backlog = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy = false;

  constructor(deps: CollectDeps, onReport: (report: CollectReport) => void = () => {}) {
    this.#deps = deps;
    this.#onReport = onReport;
  }

  start(tickMs = TICK_MS): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), tickMs);
    // A pending tick must not keep a process alive that is otherwise done.
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** Collects every due agent. Overlapping ticks are skipped, not queued. */
  async tick(now: Date = new Date()): Promise<CollectReport[]> {
    if (this.#busy) return [];
    this.#busy = true;
    const reports: CollectReport[] = [];
    try {
      for (const agent of this.#deps.store.agents()) {
        if (!isDue(agent, this.#deps.store.agentState(agent.id), now, this.#backlog.has(agent.id))) continue;
        reports.push(await this.#run(agent.id, now));
      }
    } finally {
      this.#busy = false;
    }
    return reports;
  }

  /** "Collect now" from the UI or CLI; waits for a tick already in progress rather than overlapping it. */
  async collectNow(agentId: string): Promise<CollectReport> {
    while (this.#busy) await new Promise((resolve) => setTimeout(resolve, 200));
    this.#busy = true;
    try {
      return await this.#run(agentId, new Date());
    } finally {
      this.#busy = false;
    }
  }

  async #run(agentId: string, now: Date): Promise<CollectReport> {
    const report = await collectAgent(agentId, this.#deps, now);
    if (report.backlog) this.#backlog.add(agentId);
    else this.#backlog.delete(agentId);
    this.#onReport(report);
    return report;
  }
}
