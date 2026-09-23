/**
 * Getting an alert in front of someone: a macOS notification on the machine
 * Agent Watch runs on, and a POST to a webhook — Slack and Teams incoming
 * webhooks both render a top-level `text`.
 *
 * Delivery failures are recorded on the alert, never thrown: an unreachable
 * webhook must not stop the next agent from being collected, and the alert is
 * still visible in the app either way.
 */
import { execFile } from 'node:child_process';
import type { Agent } from '../agents/model.ts';
import type { Rubric } from '../rubrics/model.ts';
import type { AlertRow, Store } from '../store/db.ts';

export interface Notifier {
  macos(title: string, subtitle: string, message: string): Promise<void>;
  webhook(url: string, payload: Record<string, unknown>): Promise<void>;
}

/** An AppleScript string literal. Quotes and backslashes are the only escapes it needs. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export const systemNotifier: Notifier = {
  macos(title, subtitle, message) {
    if (process.platform !== 'darwin') return Promise.reject(new Error('not macOS'));
    const script =
      `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}` +
      ` subtitle ${appleScriptString(subtitle)}`;
    return new Promise((resolve, reject) => {
      // Arguments, never a shell string: the message carries rubric text.
      execFile('osascript', ['-e', script], { timeout: 5000 }, (error) => (error ? reject(error) : resolve()));
    });
  },
  async webhook(url, payload) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`webhook answered ${response.status}`);
  },
};

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function alertMessage(alert: AlertRow, rubric: Rubric, agent: Agent, late: boolean): {
  title: string; subtitle: string; message: string; text: string;
} {
  const threshold = rubric.alert?.threshold ?? 1;
  const window = rubric.alert?.window ?? 'session';
  const what = threshold === 1
    ? rubric.name
    : `${rubric.name}: ${alert.count} ${window === 'session' ? 'in one session' : `in one ${window}`}`;
  const timing = late
    ? `happened ${when(alert.happenedAt)}, detected ${when(alert.detectedAt)}`
    : `at ${when(alert.happenedAt)}`;
  const session = alert.sessions.length === 1 ? `session ${alert.sessions[0].slice(0, 8)}` : `${alert.sessions.length} sessions`;
  return {
    title: `Agent Watch · ${agent.name}`,
    subtitle: what,
    message: `${session}, ${timing}`,
    text: `*${agent.name}* — ${what}. ${session[0].toUpperCase()}${session.slice(1)}, ${timing}.`,
  };
}

export async function deliverAlert(
  alert: AlertRow,
  rubric: Rubric,
  agent: Agent,
  late: boolean,
  store: Pick<Store, 'updateAlert'>,
  notifier: Notifier = systemNotifier,
  appUrl = 'http://localhost:4174',
): Promise<Record<string, string>> {
  const message = alertMessage(alert, rubric, agent, late);
  const delivered: Record<string, string> = {};

  if (agent.alerts.macos) {
    try {
      await notifier.macos(message.title, message.subtitle, message.message);
      delivered.macos = 'ok';
    } catch (error) {
      delivered.macos = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else delivered.macos = 'off';

  if (agent.alerts.webhookUrl) {
    try {
      await notifier.webhook(agent.alerts.webhookUrl, {
        text: message.text,
        agent: { id: agent.id, name: agent.name },
        rubric: { id: rubric.id, name: rubric.name, question: rubric.question },
        count: alert.count,
        threshold: rubric.alert?.threshold ?? 1,
        window: alert.windowKey,
        happenedAt: alert.happenedAt,
        detectedAt: alert.detectedAt,
        late,
        sessions: alert.sessions,
        link: `${appUrl}/#agent=${encodeURIComponent(agent.id)}`,
      });
      delivered.webhook = 'ok';
    } catch (error) {
      delivered.webhook = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else delivered.webhook = 'off';

  store.updateAlert(alert.id, { delivered });
  return delivered;
}
