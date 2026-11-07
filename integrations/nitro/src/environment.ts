/**
 * The runtime facts of the server process the plugin serves at `/__piwi/environment` outside production: the
 * runtime, the operating system, the time zone, the locale and when the process started. The Piwi reporter reads it as
 * a test first reaches the server and again as the run's last test ends, so a failure that depends on the server's clock, zone or locale can be told from one in the code. It
 * carries only the fields below: never other environment variables, file paths or connection strings.
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
  hostname: string | null;
  /** An id of the server process: another one after a restart. */
  instance: string | null;
  /** When the process started, as an ISO date. */
  startedAt: string | null;
  /** The server's clock, epoch ms. */
  now: number | null;
}

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
  instanceId: () => instance().id,
  uptime: () => process.uptime(),
  now: () => Date.now(),
};

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

/** Builds the `/__piwi/environment` body from {@link readers}. */
export function buildServerEnvironment(readers: EnvironmentReaders = defaultReaders): ServerEnvironment {
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
    appVersion: null,
    hostname: read(readers.hostname),
    instance: read(readers.instanceId),
    startedAt: uptime === null ? null : new Date(now - uptime * 1000).toISOString(),
    now,
  };
}
