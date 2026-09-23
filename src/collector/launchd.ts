/**
 * Keeping Agent Watch running on a Mac.
 *
 * A LaunchAgent starts the watch process at login and restarts it if it dies,
 * which is what "runs as long as the machine is on" means in practice. When the
 * machine sleeps, the process sleeps with it; on wake, the scheduler's first
 * tick finds every agent overdue and catches up from its watermark.
 *
 * Installing one is a lasting change to the user's login items, so it happens
 * only when asked, never as a side effect of starting the app.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LABEL = 'com.jev-cognigy-qa.agent-watch';

export function plistPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildPlist(options: { node: string; cli: string; workingDirectory: string; logDirectory: string; path: string }): string {
  const args = [options.node, '--disable-warning=ExperimentalWarning', options.cli, 'watch']
    .map((arg) => `    <string>${xml(arg)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(options.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(options.logDirectory, 'agent-watch.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(options.logDirectory, 'agent-watch.err.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(options.path)}</string>
  </dict>
</dict>
</plist>
`;
}

function launchctl(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('launchctl', args, { timeout: 10_000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, output: `${stdout}${stderr}`.trim() }),
    );
  });
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;

export async function installDaemon(packageRoot: string): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('The background service is macOS-only; run `jev-cognigy-qa watch` instead.');
  const path = plistPath();
  const logDirectory = join(packageRoot, 'logs');
  mkdirSync(logDirectory, { recursive: true });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(path, buildPlist({
    node: process.execPath,
    cli: join(packageRoot, 'bin', 'cli.ts'),
    workingDirectory: packageRoot,
    logDirectory,
    path: process.env.PATH ?? '/usr/bin:/bin',
  }));
  await launchctl(['bootout', domain(), path]);
  const loaded = await launchctl(['bootstrap', domain(), path]);
  if (!loaded.ok) throw new Error(`launchctl refused the service: ${loaded.output}`);
  return path;
}

export async function uninstallDaemon(): Promise<boolean> {
  const path = plistPath();
  if (!existsSync(path)) return false;
  await launchctl(['bootout', domain(), path]);
  unlinkSync(path);
  return true;
}

export async function daemonStatus(): Promise<{ installed: boolean; running: boolean }> {
  const installed = existsSync(plistPath());
  if (!installed || process.platform !== 'darwin') return { installed, running: false };
  const printed = await launchctl(['print', `${domain()}/${LABEL}`]);
  return { installed, running: printed.ok && /state = running/.test(printed.output) };
}
