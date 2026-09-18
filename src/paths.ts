/**
 * Where the tool keeps its configuration and data.
 *
 * Both resolve against the installation rather than the working directory, so
 * `jev-cognigy-qa` behaves the same wherever it is run from. Resolving against
 * the cwd looks fine until an agent runs the command from somewhere else and
 * gets "missing configuration" for a tool that is configured, or silently
 * writes a second, empty database.
 *
 * A `.env` in the current directory still wins, so a project can carry its own
 * credentials, and both can be overridden outright.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The package root, one level up from `src/`. */
export const PACKAGE_ROOT = resolve(import.meta.dirname, '..');

/** The `.env` to load: the one in the working directory, else the installed one. */
export function envFile(): string | undefined {
  const local = resolve(process.cwd(), '.env');
  if (existsSync(local)) return local;
  const installed = join(PACKAGE_ROOT, '.env');
  return existsSync(installed) ? installed : undefined;
}

/** Where scored runs are stored. `JEV_QA_DB` overrides it. */
export function databaseFile(): string {
  return process.env.JEV_QA_DB ?? join(PACKAGE_ROOT, 'data', 'qa.db');
}
