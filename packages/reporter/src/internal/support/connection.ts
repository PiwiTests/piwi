/**
 * The dashboard a command talks to, from its flags, the environment, the
 * workspace `.env` files, then the desktop app's discovery file, in that order
 * (`resolvePiwiConnection` in `@piwitests/core/dotenv` keeps each key with the
 * URL it came with).
 */
import * as path from 'node:path';
import { resolvePiwiConnection, type PiwiConnection } from '@piwitests/core/dotenv';
import { defaultDesktopConfigPath, readDesktopConfig } from '../config/desktop.js';
import { readDotEnv } from '../config/dotenv.js';
import { PIWI_DESKTOP_CONFIG_ENV } from '../config/env.js';

export function resolveCliConnection(
  flags: { serverUrl?: string; apiKey?: string; project?: string },
  env: NodeJS.ProcessEnv,
  dirs: string[],
): PiwiConnection | null {
  let dotEnv: Record<string, string> = {};
  for (const dir of dirs) dotEnv = { ...readDotEnv(path.join(dir, '.env')), ...dotEnv };
  return resolvePiwiConnection({
    flags,
    env,
    dotEnv,
    desktop: readDesktopConfig(env[PIWI_DESKTOP_CONFIG_ENV] || defaultDesktopConfigPath()),
  });
}
