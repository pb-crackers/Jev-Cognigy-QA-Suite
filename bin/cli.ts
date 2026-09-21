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

function start(): void {
  let deps;
  try {
    deps = buildDeps();
  } catch (error) {
    console.error('\n  ' + red('FAILED') + ' ' + clean(error) + '\n');
    process.exitCode = 1;
    return;
  }

  const rubrics = deps.store.rubrics().length;
  createApp(deps).listen(PORT, () => {
    const url = 'http://localhost:' + PORT;
    console.log('\n  ' + bold('Jev Cognigy QA') + ' ' + dim('- ' + rubrics + ' rubrics loaded'));
    console.log('  ' + green('->') + ' ' + url + '\n');
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
  const { api, odata, store } = deps();
  const headlessDeps = { api, odata, store };

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
    console.log(briefing(runId, headlessDeps));
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

  fail('unknown command "' + command + '"');
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
`;

const [command, ...rest] = process.argv.slice(2);
const HEADLESS = new Set([
  'projects', 'endpoints', 'channels', 'rubrics', 'rubric', 'score', 'report', 'brief',
]);

if (command === 'init') await init();
else if (!command) start();
else if (HEADLESS.has(command)) await headless(command, rest);
else if (command === 'help' || command === '--help') console.log(USAGE);
else {
  console.error('Unknown command "' + command + '".' + USAGE);
  process.exitCode = 1;
}
