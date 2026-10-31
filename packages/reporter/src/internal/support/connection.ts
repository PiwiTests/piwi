/**
 * The dashboard a command talks to, from its flags, the environment, the
 * workspace `.env` files, then the desktop app's discovery file, in that order
 * (`resolvePiwiConnection` in `@piwitests/core/dotenv` keeps each key with the
 * URL it came with). `PIWI_DESKTOP_APP` places the desktop app with the
 * reporter's three modes: `off` never reads it, `prefer` puts it before the
 * environment and the `.env` outside CI (a `--server-url` flag still wins), and
 * `fallback`, the default, uses it only when no flag, variable or `.env` names
 * a URL or an API key. The `desktopApp` option of the Playwright config is not
 * read: the mode comes from `PIWI_DESKTOP_APP` alone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolvePiwiConnection, type PiwiConnection } from '@piwitests/core/dotenv';
import { defaultDesktopConfigPath, readDesktopConfig } from '../config/desktop.js';
import { readDotEnv } from '../config/dotenv.js';
import { PIWI_DESKTOP_CONFIG_ENV, PIWI_ENV_KEYS, desktopAppMode } from '../config/env.js';
import { detectCi } from './ci.js';

const CONFIG_NAMES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'];

/**
 * The directory of the nearest Playwright config at or above `from`, looking
 * no higher than `root` when it is given; null when there is none.
 */
export function findPlaywrightRoot(from: string, root?: string | null): string | null {
  const top = root ? path.resolve(root) : null;
  let dir = path.resolve(from);
  for (;;) {
    if (CONFIG_NAMES.some((name) => fs.existsSync(path.join(dir, name)))) return dir;
    const parent = path.dirname(dir);
    if (dir === top || parent === dir) return null;
    dir = parent;
  }
}

/** The root of the git repository holding `cwd`; null outside one. */
export function gitRoot(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? path.resolve(out) : null;
  } catch {
    return null;
  }
}

/**
 * The folders whose `.env` a command run from `cwd` reads, first first: the
 * nearest Playwright config's folder within the repository, `cwd`, then the
 * repository root.
 */
export function connectionFolders(cwd: string): string[] {
  const root = gitRoot(cwd);
  const dirs = [findPlaywrightRoot(cwd, root) ?? cwd, cwd, root];
  return [...new Set(dirs.filter((dir): dir is string => dir !== null).map((dir) => path.resolve(dir)))];
}

/** The project variable of a source, alone. */
function projectOf(source: Record<string, string | undefined>): Record<string, string> {
  const project = source[PIWI_ENV_KEYS.projectName];
  return project ? { [PIWI_ENV_KEYS.projectName]: project } : {};
}

/**
 * The connection variables of the `.env` files of `dirs`: the URL and the key
 * of the first file that names a URL, as a pair, so a file's key never goes
 * with another file's URL, and the project of the first file that sets one.
 * An empty value counts as unset.
 */
function readDotEnvConnection(dirs: string[]): { vars: Record<string, string>; anyKey: boolean } {
  const files = dirs.map((dir) => readDotEnv(path.join(dir, '.env')));
  const withUrl = files.find((file) => file[PIWI_ENV_KEYS.serverUrl]);
  const vars: Record<string, string> = {};
  if (withUrl) {
    vars[PIWI_ENV_KEYS.serverUrl] = withUrl[PIWI_ENV_KEYS.serverUrl]!;
    if (withUrl[PIWI_ENV_KEYS.apiKey]) vars[PIWI_ENV_KEYS.apiKey] = withUrl[PIWI_ENV_KEYS.apiKey]!;
  }
  const project = files.find((file) => file[PIWI_ENV_KEYS.projectName])?.[PIWI_ENV_KEYS.projectName];
  if (project) vars[PIWI_ENV_KEYS.projectName] = project;
  return { vars, anyKey: files.some((file) => file[PIWI_ENV_KEYS.apiKey]) };
}

/**
 * The connection of a command. `dirs` are the folders whose `.env` it reads,
 * first first (see `readDotEnvConnection`). When an `--api-key` flag is given
 * and the URL comes from a `.env` or the desktop app, the key is not sent and
 * one line on stderr, prefixed with `command`, says so.
 */
export function resolveCliConnection(
  flags: { serverUrl?: string; apiKey?: string; project?: string },
  env: NodeJS.ProcessEnv,
  dirs: string[],
  command = 'piwi',
): PiwiConnection | null {
  const { vars: dotEnv, anyKey } = readDotEnvConnection(dirs);
  const mode = desktopAppMode(undefined, env[PIWI_ENV_KEYS.desktopApp]);
  const preferLocally = mode === 'prefer' && !flags.serverUrl && !detectCi(env);
  const urlSet = Boolean(flags.serverUrl || env[PIWI_ENV_KEYS.serverUrl] || dotEnv[PIWI_ENV_KEYS.serverUrl]);
  const keySet = Boolean(flags.apiKey || env[PIWI_ENV_KEYS.apiKey] || anyKey);
  const readDesktop = mode !== 'off' && (preferLocally || urlSet || !keySet);
  const desktop = readDesktop ? readDesktopConfig(env[PIWI_DESKTOP_CONFIG_ENV] || defaultDesktopConfigPath()) : null;
  const preferDesktop = desktop !== null && preferLocally;
  const connection = resolvePiwiConnection(
    preferDesktop
      ? { flags, env: projectOf(env), dotEnv: projectOf(dotEnv), desktop }
      : { flags, env, dotEnv, desktop },
  );
  if (connection && flags.apiKey && connection.apiKey !== flags.apiKey) {
    const from = !preferDesktop && dotEnv[PIWI_ENV_KEYS.serverUrl] ? 'a .env file' : 'the desktop app';
    console.error(
      `${command}: --api-key is not sent to ${connection.serverUrl}, which comes from ${from}: a key goes only to the URL given with it. Pass --server-url to name the instance the key is for.`,
    );
  }
  return connection;
}
