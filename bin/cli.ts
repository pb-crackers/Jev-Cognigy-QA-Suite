#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * `init` walks through configuration and checks every credential by actually
 * calling the service it belongs to. That matters more than it sounds: the OData
 * host is region-matched to the management API host, and a mismatch returns 401
 * with a valid key, so a bare "unauthorised" would send someone looking for a
 * permission that was never missing. The check suggests the paired host instead.
 *
 * With no arguments it starts the server and opens a browser.
 */
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { CognigyApi } from '../src/cognigy/api.ts';
import { OdataClient } from '../src/cognigy/odata.ts';
import {
  fromEnv, missingKeys, suggestOdataBase, writeEnvFile, type Config,
} from '../src/config.ts';
import { buildDeps, createApp } from '../src/server.ts';
import { envFile, PACKAGE_ROOT } from '../src/paths.ts';
import { labelFor } from '../src/cognigy/channels.ts';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  briefing, buildReport, completeRubric, resolveProject, score, validateRubric,
} from '../src/headless.ts';
import type { Rubric } from '../src/rubrics/model.ts';
import { Scheduler } from '../src/collector/scheduler.ts';
import type { CollectReport } from '../src/collector/collect.ts';
import { daemonStatus, installDaemon, uninstallDaemon } from '../src/collector/launchd.ts';
import { AgentError, createAgent, updateAgent } from '../src/agents/service.ts';
import { suggestAgents } from '../src/agents/suggest.ts';
import { installLogging, loggingStatus, uninstallLogging } from '../src/agents/logging.ts';
import { collectAgent } from '../src/collector/collect.ts';
import { computeHealth, WINDOW_DAYS, type HealthWindow } from '../src/health/health.ts';
import { checkCoverage } from '../src/validity/coverage.ts';
import { checkValidity } from '../src/validity/validity.ts';
import { importTraces } from '../src/traces/receiver.ts';
import { cast, endpointBase, personasFor, restEndpoint, simulate } from '../src/demo/simulate.ts';

// Load .env ourselves so every command works as a bare invocation from any
// directory. Requiring `--env-file` is friction for a person and a trap for an
// agent, which will forget it and get a confusing "missing configuration".
const configFile = envFile();
if (configFile) {
  try {
    process.loadEnvFile(configFile);
  } catch {
    // A malformed file should surface as missing configuration, not a crash here.
  }
}

const PORT = Number(process.env.PORT ?? 4174);

/** Built at runtime so no control characters live in the source. */
const ESC = String.fromCharCode(27);
const paint = (code: string, text: string) => ESC + '[' + code + 'm' + text + ESC + '[0m';
const green = (text: string) => paint('32', text);
const red = (text: string) => paint('31', text);
const dim = (text: string) => paint('2', text);
const bold = (text: string) => paint('1', text);

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = Date.now();
  return [await work(), Date.now() - started];
}

function clean(error: unknown): string {
  return String(error).replace(/^Error:\s*/, '');
}

async function checkTypesafe(apiKey: string): Promise<boolean> {
  try {
    const client = new TypeSafeClient({ apiKey });
    const [models, ms] = await timed(() => client.models.list());
    const names = (models as unknown as { name: string }[]).map((model) => model.name);
    console.log('    ' + green('OK') + ' reachable ' + dim('- ' + names.slice(0, 2).join(', ') + ' - ' + ms + 'ms'));
    return true;
  } catch (error) {
    console.log('    ' + red('FAILED') + ' ' + clean(error));
    return false;
  }
}

async function checkCognigyApi(base: string, apiKey: string): Promise<boolean> {
  try {
    const [result, ms] = await timed(() => new CognigyApi(base, apiKey).check());
    console.log('    ' + green('OK') + ' authenticated ' + dim('- ' + result.projects + ' project(s) visible - ' + ms + 'ms'));
    return true;
  } catch (error) {
    console.log('    ' + red('FAILED') + ' ' + clean(error));
    console.log(dim('      Check that this is a profile API key, and that the base URL is right.'));
    return false;
  }
}

async function checkOdata(base: string, apiKey: string, apiBase: string): Promise<boolean> {
  try {
    const [, ms] = await timed(() => new OdataClient(base, apiKey).check());
    console.log('    ' + green('OK') + ' Conversations readable ' + dim('- ' + ms + 'ms'));
    return true;
  } catch (error) {
    console.log('    ' + red('FAILED') + ' ' + clean(error));
    const suggestion = suggestOdataBase(apiBase);
    if (suggestion && suggestion !== base) {
      console.log(dim('      The OData host is region-matched to the API host. Try:'));
      console.log(dim('        ' + suggestion));
    } else {
      console.log(dim('      OData access also needs the `odata` global role on your user.'));
    }
    return false;
  }
}

async function init(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const existing = fromEnv();

  const ask = async (label: string, fallback?: string): Promise<string> => {
    const shown = fallback ? ' ' + dim('[' + fallback + ']') : '';
    const answer = (await rl.question('  ' + bold(label) + shown + ' ')).trim();
    return answer || fallback || '';
  };

  console.log('\n  ' + bold('Jev Cognigy QA') + ' - configuration\n');

  const config: Partial<Config> = {};

  for (;;) {
    config.typesafeApiKey = await ask('TypeSafe API key', existing.typesafeApiKey);
    if (await checkTypesafe(config.typesafeApiKey)) break;
  }

  for (;;) {
    config.cognigyApiBase = await ask(
      'Cognigy API base',
      existing.cognigyApiBase ?? 'https://api-trial.cognigy.ai',
    );
    config.cognigyApiKey = await ask('Cognigy API key', existing.cognigyApiKey);
    if (await checkCognigyApi(config.cognigyApiBase, config.cognigyApiKey)) break;
  }

  for (;;) {
    config.cognigyOdataBase = await ask(
      'OData base',
      existing.cognigyOdataBase ?? suggestOdataBase(config.cognigyApiBase),
    );
    if (await checkOdata(config.cognigyOdataBase, config.cognigyApiKey!, config.cognigyApiBase!)) {
      break;
    }
  }

  const projects = await new CognigyApi(config.cognigyApiBase!, config.cognigyApiKey!).projects();
  if (projects.length > 0) {
    console.log();
    projects.forEach((project, index) => console.log('    ' + dim('[' + (index + 1) + ']') + ' ' + project.name));
    const choice = await ask('Default project (number, or blank to choose later)');
    const picked = projects[Number(choice) - 1];
    if (picked) config.projectId = picked.id;
  }

  rl.close();
  await writeEnvFile(config as Config, configFile ?? join(PACKAGE_ROOT, '.env'));
  console.log('\n  ' + green('OK') + ' Written to .env ' + dim('(gitignored)'));
  console.log('  ' + dim('Run') + ' npx jev-cognigy-qa ' + dim('to start.') + '\n');
}

/** One line per collection, so the watch log reads as a history of what happened. */
function logCollection(report: CollectReport): void {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const parts = [
    `${report.scored} scored`, report.deferred ? `${report.deferred} in progress` : '',
    report.alertsFired ? `${report.alertsFired} alert(s)` : '', report.backlog ? 'more to catch up' : '',
    ...report.warnings,
  ].filter(Boolean);
  console.log(`  ${dim(stamp)} ${report.agentId}: ${report.error ? red('failed: ' + report.error) : parts.join(', ')}`);
}

/**
 * The app and the monitor are one process: the web UI, the webhook Cognigy
 * posts to, and the collector loop. `watch` is the same without opening a
 * browser, which is what the background service runs.
 */
function start(options: { openBrowser: boolean; demo?: boolean } = { openBrowser: true }): void {
  let deps;
  try {
    deps = buildDeps();
  } catch (error) {
    console.error('\n  ' + red('FAILED') + ' ' + clean(error) + '\n');
    process.exitCode = 1;
    return;
  }

  // Demo mode collects every minute and scores a conversation once it has been
  // quiet for one, so a simulated chat reaches the board while you watch.
  const scheduler = new Scheduler(
    { api: deps.api, odata: deps.odata, store: deps.store, appUrl: 'http://localhost:' + PORT,
      settleMinutes: options.demo ? 1 : undefined },
    logCollection,
    { intervalMinutes: options.demo ? 1 : undefined },
  );
  const rubrics = deps.store.rubrics().length;
  const agents = deps.store.agents().length;
  // Loopback only. A tunnel runs on this machine and reaches it here; nothing on
  // the network can, and the app refuses tunnelled requests for anything but
  // the webhook.
  createApp({ ...deps, scheduler, demo: options.demo, feed: [] }).listen(PORT, '127.0.0.1', () => {
    const url = 'http://localhost:' + PORT;
    console.log('\n  ' + bold('Jev Cognigy QA') + ' ' + dim(`- ${rubrics} rubrics, ${agents} agent(s) watched`));
    console.log('  ' + green('->') + ' ' + url);
    console.log('  ' + dim('webhook  ') + (deps.config.publicUrl ? deps.config.publicUrl + '/hook/<agent>' : dim('set AGENT_WATCH_PUBLIC_URL to receive LLM logs')) + '\n');
    if (options.demo) console.log('  ' + bold('Demo mode') + dim(' — collecting every minute, scoring a chat after one quiet minute') + '\n');
    scheduler.start(options.demo ? 15_000 : undefined);
    if (!options.openBrowser) return;
    // Best effort: failing to open a browser must not stop the server.
    const opener = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {});
  });
}

// ---------- headless commands ----------

/**
 * Minimal flag parser: `--key value`, and `--flag` for booleans.
 *
 * A flag given more than once collects into an array, so `--channel a
 * --channel b` reads as a list rather than the last value silently winning.
 */
type FlagValue = string | boolean | string[];

function parseFlags(argv: string[]): Record<string, FlagValue> {
  const flags: Record<string, FlagValue> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    const value: string | boolean = next === undefined || next.startsWith('--') ? true : next;
    if (typeof value === 'string') i++;

    const existing = flags[key];
    if (existing === undefined) flags[key] = value;
    else if (Array.isArray(existing)) existing.push(String(value));
    else flags[key] = [String(existing), String(value)];
  }
  return flags;
}

/** A flag that may legitimately appear several times, read as a list. */
function asList(value: FlagValue | undefined): string[] | undefined {
  if (value === undefined || value === true) return undefined;
  return Array.isArray(value) ? value : [String(value)];
}

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message: string): never {
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

function deps() {
  try {
    return buildDeps();
  } catch (error) {
    return fail(clean(error));
  }
}

async function headless(command: string, argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const { api, odata, store, config } = deps();
  const headlessDeps = { api, odata, store, config };

  if (command === 'projects') return out(await api.projects());

  if (command === 'endpoints') {
    const needle = String(flags.project ?? '');
    if (!needle) return fail('--project is required');
    const project = await resolveProject(api, needle);
    const endpoints = await api.endpoints(project.id);
    return out({
      project,
      endpoints: [
        { id: null, name: 'interaction-panel', note: 'Sessions with no endpoint' },
        ...endpoints,
      ],
    });
  }

  if (command === 'rubrics') return out(store.rubrics());

  if (command === 'channels') {
    const needle = String(flags.project ?? '');
    if (!needle) return fail('--project is required');
    const project = await resolveProject(api, needle);
    const from = String(flags.from ?? '');
    const to = String(flags.to ?? '');
    if (!from || !to) return fail('--from and --to are required');

    const sessions = await odata.sessions({
      projectId: project.id,
      from: from.length === 10 ? from + 'T00:00:00Z' : from,
      to: to.length === 10 ? to + 'T23:59:59Z' : to,
      limit: Number(flags.limit ?? 500),
    });

    const byLabel = new Map<string, { label: string; raws: Set<string>; sessions: number }>();
    for (const session of sessions) {
      const resolved = labelFor(session.channel);
      const entry = byLabel.get(resolved.label)
        ?? { label: resolved.label, raws: new Set<string>(), sessions: 0 };
      entry.raws.add(resolved.raw);
      entry.sessions++;
      byLabel.set(resolved.label, entry);
    }
    return out({
      project,
      channels: [...byLabel.values()]
        .map((entry) => ({ ...entry, raws: [...entry.raws] }))
        .sort((a, b) => b.sessions - a.sessions),
    });
  }

  if (command === 'rubric') {
    const [sub, ...rest] = argv;
    const subFlags = parseFlags(rest);

    if (sub === 'add') {
      const raw = subFlags.file
        ? await readFile(String(subFlags.file), 'utf8')
        : String(subFlags.json ?? '');
      if (!raw) return fail('pass --json <string> or --file <path>');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return fail('could not parse JSON: ' + clean(error));
      }

      const list = Array.isArray(parsed) ? parsed : [parsed];
      const saved = [];
      for (const candidate of list) {
        const problems = validateRubric(candidate);
        if (problems.length > 0) {
          return fail('invalid rubric "' + ((candidate as { name?: string }).name ?? '?') + '": ' + problems.join('; '));
        }
        const rubric = completeRubric(candidate as Rubric);
        rubric.id ||= randomUUID().slice(0, 8);
        rubric.weight ??= 1;
        rubric.enabled ??= true;
        store.saveRubric(rubric);
        saved.push(rubric);
      }
      return out({ saved: saved.length, rubrics: saved });
    }

    if (sub === 'rm') {
      const id = rest[0];
      if (!id) return fail('pass a rubric id');
      store.deleteRubric(id);
      return out({ deleted: id });
    }

    return fail('rubric subcommands: add, rm');
  }

  if (command === 'score') {
    const project = String(flags.project ?? '');
    const from = String(flags.from ?? '');
    const to = String(flags.to ?? '');
    if (!project || !from || !to) return fail('--project, --from and --to are required');

    const quiet = Boolean(flags.json);
    const report = await score(
      {
        project,
        from: from.length === 10 ? from + 'T00:00:00Z' : from,
        to: to.length === 10 ? to + 'T23:59:59Z' : to,
        endpoint: flags.endpoint === undefined ? undefined : String(flags.endpoint),
        channels: asList(flags.channel),
        limit: Number(flags.limit ?? 100),
        skipScored: flags['no-skip'] !== true,
      },
      headlessDeps,
      quiet
        ? undefined
        : (progress) => {
            if (progress.currentSession) {
              process.stderr.write(
                '  ' + progress.done + '/' + progress.total + ' scored, ' +
                  progress.costUsd.toFixed(6) + ' spent\n',
              );
            }
          },
    );
    return out(report);
  }

  if (command === 'brief') {
    const runId = argv[0] ?? store.runs()[0]?.id;
    if (!runId) return fail('no runs yet — score a batch first');
    // Markdown, not JSON: this output is meant to be read or handed to an agent.
    console.log(await briefing(runId, headlessDeps));
    return;
  }

  if (command === 'report') {
    const runId = argv[0];
    if (!runId) {
      const runs = store.runs();
      return out(runs.length > 0 ? runs : { runs: [], note: 'No runs yet' });
    }
    return out(buildReport(runId, headlessDeps));
  }

  if (command === 'agents') {
    const window = asWindow(flags.window);
    return out(store.agents().map((agent) => {
      const health = computeHealth(agent, store.rubrics(), store, window);
      return {
        id: agent.id, name: agent.name, enabled: agent.enabled, endpoints: agent.endpoints.map((e) => e.name),
        includePanel: agent.includePanel, intervalMinutes: agent.intervalMinutes,
        health: health.health, interval: health.interval, sessions: health.sessions, reportable: health.reportable,
        alerts: health.alerts, state: store.agentState(agent.id), loggingInstalled: agent.trace.installs.length,
      };
    }));
  }

  if (command === 'agent') return agentCommand(argv, flags, { api, odata, store, config });

  if (command === 'alerts') {
    return out(store.alerts({ agentId: flags.agent ? String(flags.agent) : undefined, limit: 100 }));
  }

  if (command === 'validity') {
    const { reports, ledger } = await checkValidity(store, store.rubrics(), { stability: Boolean(flags.stability) });
    return out({ costUsd: ledger.totals().costUsd, reports: reports.map((report) => ({
      rubric: report.rubricId, validity: Number(report.validity.toFixed(3)), stability: report.stability, warnings: report.warnings,
    })) });
  }

  if (command === 'trace') {
    if (argv[0] !== 'import') return fail('usage: trace import <agentId> --file <path>');
    const agentId = argv[1];
    if (!agentId || !flags.file) return fail('usage: trace import <agentId> --file <path>');
    return out(importTraces(store, agentId, JSON.parse(await readFile(String(flags.file), 'utf8'))));
  }

  if (command === 'simulate') {
    const base = endpointBase(config.cognigyApiBase, process.env.COGNIGY_ENDPOINT_BASE);
    if (!base) return fail('cannot work out the endpoint host; set COGNIGY_ENDPOINT_BASE');
    const agents = flags.all ? store.agents().filter((agent) => agent.enabled && restEndpoint(agent)) : [store.agent(String(flags.agent ?? ''))];
    if (!agents[0]) return fail(flags.all ? 'no watched agent has a REST endpoint' : '--agent <id> or --all is required; see `agents`');
    const only = flags.personas ? String(flags.personas).split(',').map((id) => id.trim()) : undefined;
    const runs = agents.map((agent) => {
      const endpoint = restEndpoint(agent!);
      if (!endpoint) return fail(`${agent!.name} has no REST endpoint to talk to`);
      const set = personasFor(agent!);
      const personas = cast(flags.count ? Number(flags.count) : set.length, only, set);
      if (!personas.length) return fail(`no such persona for ${agent!.name}; choose from ${set.map((p) => p.id).join(', ')}`);
      process.stderr.write(`Starting ${personas.length} conversations with ${agent!.name}\n`);
      const tag = agents.length > 1 ? `${agent!.name.replace(/^Summit Ridge /, '')}/` : '';
      return simulate({
        url: `${base}/${endpoint.urlToken}`,
        personas,
        onTurn: (event) => {
          const who = `[${tag}${event.persona}]`;
          process.stderr.write(`  ${who} > ${event.said}\n`);
          if (event.error) process.stderr.write(`  ${who} ! ${event.error}\n`);
          for (const reply of event.replies) process.stderr.write(`  ${who} < ${reply.replace(/\s+/g, ' ').slice(0, 140)}\n`);
        },
      }).then((result) => ({ agentId: agent!.id, ...result }));
    });
    return out(await Promise.all(runs));
  }

  if (command === 'daemon') {
    const action = argv[0];
    if (action === 'install') return out({ installed: await installDaemon(PACKAGE_ROOT) });
    if (action === 'uninstall') return out({ removed: await uninstallDaemon() });
    if (action === 'status' || !action) return out(await daemonStatus());
    return fail('usage: daemon install | uninstall | status');
  }

  fail('unknown command "' + command + '"');
}

function asWindow(value: unknown): HealthWindow {
  return typeof value === 'string' && value in WINDOW_DAYS ? (value as HealthWindow) : '24h';
}

async function agentCommand(
  argv: string[],
  flags: Record<string, unknown>,
  deps: { api: ReturnType<typeof buildDeps>['api']; odata: ReturnType<typeof buildDeps>['odata']; store: ReturnType<typeof buildDeps>['store']; config: ReturnType<typeof buildDeps>['config'] },
): Promise<void> {
  const { api, odata, store, config } = deps;
  const [action, id] = argv;
  const need = () => {
    const agent = id ? store.agent(id) : undefined;
    if (!agent) throw new AgentError([id ? `no agent "${id}"` : 'an agent id is required']);
    return agent;
  };

  try {
    if (action === 'suggest') {
      const needle = String(flags.project ?? '');
      if (!needle) return fail('--project is required');
      const project = await resolveProject(api, needle);
      return out({ project, suggestions: await suggestAgents(api, project.id, store.agents()) });
    }
    if (action === 'add') {
      // From a suggestion id (`--project X --suggestion summit-ridge`) or from JSON.
      if (flags.suggestion) {
        const project = await resolveProject(api, String(flags.project ?? ''));
        const suggestion = (await suggestAgents(api, project.id, store.agents())).find((s) => s.id === flags.suggestion);
        if (!suggestion) return fail(`no suggestion "${flags.suggestion}" for ${project.name}`);
        return out(createAgent({ name: suggestion.name, projectId: project.id, projectName: project.name,
          endpoints: suggestion.endpoints, includePanel: Boolean(flags.panel) }, store, store.rubrics()));
      }
      const json = flags.file ? await readFile(String(flags.file), 'utf8') : String(flags.json ?? '');
      if (!json) return fail('agent add needs --suggestion <id> --project <name>, or --json / --file');
      return out(createAgent(JSON.parse(json), store, store.rubrics()));
    }
    if (action === 'edit') {
      need();
      return out(updateAgent(id, JSON.parse(String(flags.json ?? '{}')), store));
    }
    if (action === 'rm') {
      const agent = need();
      if (agent.trace.installs.length && !flags['keep-logging']) {
        const { report } = await uninstallLogging(agent, api, store);
        if (report.failed.length) return fail('could not remove logging from every node; agent kept');
      }
      store.deleteAgent(agent.id);
      return out({ deleted: agent.id });
    }
    if (action === 'collect') {
      need();
      return out(await collectAgent(id, { api, odata, store }));
    }
    if (action === 'health') {
      return out(computeHealth(need(), store.rubrics(), store, asWindow(flags.window)));
    }
    if (action === 'logging') {
      const agent = need();
      if (flags.install || flags['take-over']) {
        return out((await installLogging(agent, api, store, { publicUrl: config.publicUrl, takeOver: Boolean(flags['take-over']) })).report);
      }
      if (flags.uninstall) return out((await uninstallLogging(agent, api, store)).report);
      return out({ nodes: await loggingStatus(agent, api), installs: agent.trace.installs });
    }
    if (action === 'coverage') {
      return out(await checkCoverage(need(), store.rubrics(), store));
    }
    return fail('usage: agent suggest|add|edit|rm|collect|health|logging|coverage');
  } catch (error) {
    if (error instanceof AgentError) return fail(error.message);
    throw error;
  }
}

const USAGE = `
  jev-cognigy-qa                      start the web UI
  jev-cognigy-qa init                 configure credentials interactively

  Headless (JSON in, JSON out):
    projects                          list projects
    endpoints --project <name|id>     list endpoints, plus interaction-panel
    rubrics                           list the rubric library
    rubric add --json <json>          add or update rubrics (object or array)
    rubric add --file <path>          same, from a file
    rubric rm <id>                    delete a rubric
    score --project <name|id> --from <YYYY-MM-DD> --to <YYYY-MM-DD>
          [--endpoint <name|interaction-panel>] [--limit N] [--no-skip] [--json]
          [--channel <raw value>]     repeatable; omit for every channel
    channels --project <name|id> --from <date> --to <date>
                                      what channels are present, and how many sessions
    report [<runId>]                  a previous run, or list runs
    brief [<runId>]                   synthesised findings as markdown, for an agent

  Agent Watch:
    watch [--demo]                    run the UI, webhook and collector without a browser
    agents [--window 24h|7d|30d]      every watched agent with its health
    agent suggest --project <name>    agents proposed from the project's endpoints
    agent add --project <name> --suggestion <id> [--panel]
    agent add --json <json>           or define one by hand
    agent edit <id> --json <json>     change switches, endpoints, interval, alerts
    agent rm <id> [--keep-logging]    remove an agent, taking its logging out first
    agent collect <id>                collect and score now
    agent health <id> [--window 7d]   health, per-rubric pass rates, failing sessions
    agent logging <id> [--install | --take-over | --uninstall]
                                      LLM logging on the agent's Cognigy nodes
    agent coverage <id>               instructions no rubric checks
    alerts [--agent <id>]             alerts that fired
    validity [--stability]            check every rubric; --stability re-asks sessions
    trace import <agentId> --file <path>
                                      load logged LLM calls captured elsewhere
    daemon install|uninstall|status   keep the monitor running in the background (macOS)

  Demo:
    demo                              open the app with collection every minute
    simulate --agent <id> | --all [--count <n>] [--personas <id,id>]
                                      hold simulated conversations with each agent's REST endpoint,
                                      using the customers written for that agent
`;

const [command, ...rest] = process.argv.slice(2);
const HEADLESS = new Set([
  'projects', 'endpoints', 'channels', 'rubrics', 'rubric', 'score', 'report', 'brief',
  'agents', 'agent', 'alerts', 'validity', 'trace', 'daemon', 'simulate',
]);

if (command === 'init') await init();
else if (!command) start();
else if (command === 'watch') start({ openBrowser: false, demo: rest.includes('--demo') });
else if (command === 'demo') start({ openBrowser: true, demo: true });
else if (HEADLESS.has(command)) await headless(command, rest);
else if (command === 'help' || command === '--help') console.log(USAGE);
else {
  console.error('Unknown command "' + command + '".' + USAGE);
  process.exitCode = 1;
}
