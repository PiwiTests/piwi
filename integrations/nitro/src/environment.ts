/**
 * The runtime facts of the server process the plugin serves at `/__piwi/environment` while capture is on (`NODE_ENV`
 * `development` or `test`, unless `PIWI_TEST_LOGS_DISABLED` says otherwise): the runtime, the operating system, the
 * time zone, the locale and when the process started. The Piwi reporter reads it as a test first reaches the server and
 * again as the run's last test ends, so a failure that depends on the server's clock, zone or locale can be told from
 * one in the code. It carries only the fields below: never other environment variables, file paths or connection
 * strings. `appVersion` and `appCommit` say which version of the application a run tested, for an environment deployed
 * apart from the tests' checkout.
 */
import { arch, hostname, platform, release } from 'node:os';
import { instance } from './coverage-runtime.js';

/** The body served at `/__piwi/environment`. */
export interface ServerEnvironment {
  v: 1;
  runtime: string | null;
  os: string | null;
  arch: string | null;
  timeZone: string | null;
  utcOffsetMinutes: number | null;
  locale: string | null;
  globalization: string | null;
  environmentName: string | null;
  appVersion: string | null;
  /** The commit the application was built from: 7 to 40 hexadecimal characters, lower-cased. */
  appCommit: string | null;
  hostname: string | null;
  /** An id of the server process: another one after a restart. */
  instance: string | null;
  /** When the process started, as an ISO date. */
  startedAt: string | null;
  /** The server's clock, epoch ms. */
  now: number | null;
}

/** What the plugin's options say of the application (`piwiPlugin`); each one left unset is read from the environment. */
export interface PiwiPluginOptions {
  /** The application's version, served as `appVersion`. Unset: `PIWI_APP_VERSION`, else null. */
  appVersion?: string | null;
  /**
   * The commit the application was built from, served as `appCommit`. Unset: `PIWI_APP_COMMIT`, then the commit
   * variable of the hosting platform (`VERCEL_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`,
   * `SOURCE_COMMIT`). Kept only when it is 7 to 40 hexadecimal characters.
   */
  appCommit?: string | null;
}

const APP_VERSION_VARIABLE = 'PIWI_APP_VERSION';
/** Where the commit is read from after the option, in this order: Piwi's own variable, then the hosting platforms'. */
const APP_COMMIT_VARIABLES = [
  'PIWI_APP_COMMIT',
  'VERCEL_GIT_COMMIT_SHA',
  'RENDER_GIT_COMMIT',
  'RAILWAY_GIT_COMMIT_SHA',
  'SOURCE_COMMIT',
] as const;
const COMMIT = /^[0-9a-f]{7,40}$/i;

/** Where {@link buildServerEnvironment} reads each fact from. */
export interface EnvironmentReaders {
  nodeVersion: () => string;
  platform: () => string;
  release: () => string;
  arch: () => string;
  hostname: () => string;
  resolvedOptions: () => { timeZone?: string; locale?: string };
  /** `Date#getTimezoneOffset()`: minutes west of UTC. */
  timezoneOffset: () => number;
  icuVersion: () => string | undefined;
  /** True when the runtime carries locale data beyond English. */
  hasFullIcu: () => boolean;
  nodeEnv: () => string | undefined;
  /** An environment variable of the process; `process.env` when left out. */
  variable?: (name: string) => string | undefined;
  instanceId: () => string;
  /** Seconds since the process started. */
  uptime: () => number;
  now: () => number;
}

const defaultReaders: EnvironmentReaders = {
  nodeVersion: () => process.version,
  platform: () => platform(),
  release: () => release(),
  arch: () => arch(),
  hostname: () => hostname(),
  resolvedOptions: () => Intl.DateTimeFormat().resolvedOptions(),
  timezoneOffset: () => new Date().getTimezoneOffset(),
  icuVersion: () => process.versions.icu,
  hasFullIcu: () => Intl.DateTimeFormat.supportedLocalesOf(['fr']).length > 0,
  nodeEnv: () => process.env.NODE_ENV,
  variable: (name) => readProcessVariable(name),
  instanceId: () => instance().id,
  uptime: () => process.uptime(),
  now: () => Date.now(),
};

/** An environment variable of the process. */
function readProcessVariable(name: string): string | undefined {
  return process.env[name];
}

/** Reads one fact, null when the reader throws or gives nothing. */
function read<T>(reader: () => T | null | undefined): T | null {
  try {
    const value = reader();
    return value === undefined || value === '' ? null : value;
  } catch {
    return null;
  }
}

/** The ICU version and whether its locale data is `full` or `small`, e.g. `icu 76.1 full`; null without ICU. */
function globalization(readers: EnvironmentReaders): string | null {
  const icu = read(readers.icuVersion);
  if (!icu) return null;
  const full = read(readers.hasFullIcu);
  return full === null ? `icu ${icu}` : `icu ${icu} ${full ? 'full' : 'small'}`;
}

/** The first of the option and the commit variables that holds 7 to 40 hexadecimal characters, lower-cased; else null. */
function appCommit(option: string | null | undefined, readers: EnvironmentReaders): string | null {
  for (const candidate of [option, ...APP_COMMIT_VARIABLES.map((name) => read(() => (readers.variable ?? readProcessVariable)(name)))]) {
    const commit = candidate?.trim();
    if (commit && COMMIT.test(commit)) return commit.toLowerCase();
  }
  return null;
}

/** Builds the `/__piwi/environment` body from {@link readers} and the plugin's options. */
export function buildServerEnvironment(
  readers: EnvironmentReaders = defaultReaders,
  app: PiwiPluginOptions = {},
): ServerEnvironment {
  const now = readers.now();
  const options = read(readers.resolvedOptions);
  const os = [read(readers.platform), read(readers.release)].filter(Boolean).join(' ');
  const version = read(readers.nodeVersion);
  const offset = read(readers.timezoneOffset);
  const uptime = read(readers.uptime);
  return {
    v: 1,
    runtime: version ? `Node.js ${version}` : null,
    os: os || null,
    arch: read(readers.arch),
    timeZone: options?.timeZone || null,
    utcOffsetMinutes: offset === null ? null : offset === 0 ? 0 : -offset,
    locale: options?.locale || null,
    globalization: globalization(readers),
    environmentName: read(readers.nodeEnv),
    appVersion: read(() => app.appVersion?.trim() || (readers.variable ?? readProcessVariable)(APP_VERSION_VARIABLE)?.trim()),
    appCommit: appCommit(app.appCommit, readers),
    hostname: read(readers.hostname),
    instance: read(readers.instanceId),
    startedAt: uptime === null ? null : new Date(now - uptime * 1000).toISOString(),
    now,
  };
}
