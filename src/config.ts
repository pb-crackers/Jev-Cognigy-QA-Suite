/**
 * Configuration and credential validation.
 *
 * Every credential is checked by actually calling the service it is for, because
 * the failure modes here are not obvious from the values. In particular the
 * OData host is region-matched to the management API host, and a mismatch
 * returns 401 with a perfectly valid key — so a plain "unauthorised" message
 * would send someone hunting for a missing permission that was never missing.
 */
import { readFile, writeFile } from 'node:fs/promises';

export interface Config {
  typesafeApiKey: string;
  cognigyApiBase: string;
  cognigyApiKey: string;
  cognigyOdataBase: string;
  projectId?: string;
}

export const ENV_KEYS = {
  typesafeApiKey: 'TYPESAFE_API_KEY',
  cognigyApiBase: 'COGNIGY_API_BASE',
  cognigyApiKey: 'COGNIGY_API_KEY',
  cognigyOdataBase: 'COGNIGY_ODATA_BASE',
  projectId: 'COGNIGY_PROJECT_ID',
} as const;

export function fromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
  return {
    typesafeApiKey: env[ENV_KEYS.typesafeApiKey],
    cognigyApiBase: env[ENV_KEYS.cognigyApiBase],
    cognigyApiKey: env[ENV_KEYS.cognigyApiKey],
    cognigyOdataBase: env[ENV_KEYS.cognigyOdataBase],
    projectId: env[ENV_KEYS.projectId],
  };
}

export function missingKeys(config: Partial<Config>): string[] {
  return (['typesafeApiKey', 'cognigyApiBase', 'cognigyApiKey', 'cognigyOdataBase'] as const)
    .filter((key) => !config[key]?.trim())
    .map((key) => ENV_KEYS[key]);
}

/**
 * Derives the OData host from the management API host.
 *
 * `api-trial-us.cognigy.ai` pairs with `odata-trial-us.cognigy.ai`. The
 * documentation's `odata-trial.cognigy.ai` is a different region and rejects
 * keys from this one, which is the single most confusing failure in setup.
 */
export function suggestOdataBase(cognigyApiBase: string): string | undefined {
  try {
    const host = new URL(cognigyApiBase).host;
    if (!host.startsWith('api')) return undefined;
    return `https://${host.replace(/^api/, 'odata')}/v2.4`;
  } catch {
    return undefined;
  }
}

export interface CheckResult {
  ok: boolean;
  detail: string;
  /** Actionable next step when the check failed. */
  hint?: string;
}

export async function writeEnvFile(config: Config, path = '.env'): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    // No existing file: writing a fresh one is the normal first-run path.
  }

  const lines = existing.split('\n').filter((line) => {
    const key = line.split('=')[0]?.trim();
    return line.trim() !== '' && !Object.values(ENV_KEYS).includes(key as never);
  });

  for (const [field, key] of Object.entries(ENV_KEYS)) {
    const value = config[field as keyof Config];
    if (value) lines.push(`${key}=${value}`);
  }

  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}
