#!/usr/bin/env node
/**
 * One-step install: link the CLI onto PATH and install the agent skill.
 *
 * Written to be run by a coding agent as much as by a person, so it reports what
 * it did in plain lines, never prompts, and fails loudly with the manual
 * equivalent of whatever step did not work rather than leaving a half-install.
 *
 * It deliberately does NOT touch credentials. `init` prompts for API keys and
 * belongs to the user, not to an agent acting on their behalf.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ok = (text) => console.log(`  ok    ${text}`);
const warn = (text) => console.log(`  note  ${text}`);
const fail = (text) => console.log(`  FAIL  ${text}`);

let linked = false;

// ---- 1. dependencies ----
if (!existsSync(join(ROOT, 'node_modules', '@typesafe-ai', 'sdk'))) {
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'pipe' });
    ok('dependencies installed');
  } catch (error) {
    fail(`npm install failed: ${String(error).split('\n')[0]}`);
    process.exit(1);
  }
} else {
  ok('dependencies already present');
}

// ---- 2. put the command on PATH ----
try {
  execFileSync('npm', ['link'], { cwd: ROOT, stdio: 'pipe' });
  execFileSync('jev-cognigy-qa', ['--help'], { stdio: 'pipe' });
  linked = true;
  ok('jev-cognigy-qa is on your PATH');
} catch {
  warn('could not link globally — this usually means npm needs elevated permissions.');
  warn(`run it in place instead:  node ${join(ROOT, 'bin', 'cli.ts')} <command>`);
}

// ---- 3. install the agent skill ----
/** Where each agent looks for skills. Only directories that already exist are used. */
const SKILL_HOMES = [
  { name: 'Claude Code', dir: join(homedir(), '.claude', 'skills') },
  { name: 'Codex', dir: join(homedir(), '.codex', 'skills') },
];

const source = join(ROOT, 'skills', 'jev-cognigy-qa');
let installedFor = 0;

for (const { name, dir } of SKILL_HOMES) {
  // Only install where the agent is actually set up; creating ~/.codex for
  // someone who does not use Codex is litter.
  const parent = resolve(dir, '..');
  if (!existsSync(parent)) continue;

  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'jev-cognigy-qa');
    if (existsSync(target) || statSync(target, { throwIfNoEntry: false })) {
      rmSync(target, { recursive: true, force: true });
    }
    symlinkSync(source, target, 'dir');
    ok(`skill installed for ${name}`);
    installedFor++;
  } catch (error) {
    warn(`could not install the skill for ${name}: ${String(error).split('\n')[0]}`);
  }
}

if (installedFor === 0) {
  warn('no agent skill directory found. Link it wherever your agent reads skills:');
  warn(`  ${source}`);
}

// ---- what's left, which is the part only the user can do ----
console.log('');
if (existsSync(join(ROOT, '.env'))) {
  ok('configuration found — you are ready to go');
  console.log(`\n  Try:  ${linked ? 'jev-cognigy-qa' : 'npm run dev'}   (opens the web UI)`);
} else {
  console.log('  One step left, and it is yours rather than your agent\'s:');
  console.log(`\n    ${linked ? 'jev-cognigy-qa init' : 'npm run init'}`);
  console.log('\n  It asks for your TypeSafe key and your Cognigy API key, checks each one');
  console.log('  by calling the service, and writes them to a gitignored .env.');
}
console.log('');
