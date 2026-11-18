import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

/**
 * Finds the nearest .env walking up from `startDir` (defaults to this file).
 * Works from both `infra/lib` (src) and `infra/dist/lib` (compiled) because it
 * searches upward instead of hardcoding a relative depth.
 */
export function findEnvFile(startDir: string = __dirname): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Loads .env from (in order of precedence):
 *   1. an explicit path
 *   2. process.env.ENV_FILE
 *   3. the nearest .env above this file
 * Later values override existing process.env entries, matching the previous
 * behaviour used for deploys (shell leftovers must not win).
 */
export function loadEnv(explicitPath?: string): string | undefined {
  const envPath = explicitPath
    ? path.resolve(explicitPath)
    : process.env.ENV_FILE
      ? path.resolve(process.env.ENV_FILE)
      : findEnvFile();

  if (envPath && fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
    return envPath;
  }

  return undefined;
}

/** Returns the trimmed env var or the fallback when it is unset/blank. */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}
