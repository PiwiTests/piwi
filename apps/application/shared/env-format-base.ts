/**
 * Shared vocabulary for every configuration emitter: the entry/option shapes,
 * the quoting rules for each target syntax, and the handful of constants a
 * deployment must agree on (data mount, health endpoint, default image).
 *
 * Split out from `env-format.ts` so the per-provider modules under
 * `shared/deploy/` can depend on it without importing the module that
 * assembles them into `ENV_OUTPUT_FORMATS` — that would be a cycle. Everything
 * here is re-exported from `#shared/env-format`, which stays the public entry
 * point; import from there rather than from this file.
 *
 * Like `env-format.ts` this MUST stay dependency-free and browser-safe: no
 * imports, no Node APIs. The docs-site configuration generator loads it in the
 * browser through the `#shared` alias.
 */

export interface EnvEntry {
  /** Environment variable name (`A–Z`, `0–9`, `_`). */
  name: string;
  /** The exact string value the process should receive. */
  value: string;
  /** Secret values land in the Kubernetes `Secret` instead of the `ConfigMap`. */
  secret?: boolean;
  /** Optional one-line comment rendered above the entry where the format allows it. */
  comment?: string;
  /**
   * Lets a hosting platform supply the value instead of committing a literal:
   * `generate` asks it for a fresh random secret, `url` for the service's own
   * public URL. Only the hosting-platform emitters read this — every other
   * format needs a literal and falls back to `value`.
   */
  platformValue?: 'generate' | 'url';
}

export interface EmitOptions {
  /** Docker image reference used by the container formats. */
  image?: string;
  /** Container / Kubernetes resource base name. */
  name?: string;
  /** Comment lines prefixed to the output (each format uses its own comment syntax). */
  header?: readonly string[];
  /** Port the container listens on. */
  port?: number;
  /** Persistent-disk size in GB, where the platform wants one declared. */
  diskGB?: number;
  /** Platform region slug, in that platform's own vocabulary. */
  region?: string;
}

export const DEFAULT_IMAGE = 'phenx/piwitests-server:latest';

/** The default image pinned to one release's tag, e.g. `phenx/piwitests-server:0.61.0`. */
export function imageForVersion(version: string): string {
  return DEFAULT_IMAGE.replace(/:[^:/]+$/, `:${version}`);
}
export const DEFAULT_NAME = 'piwi';

/** Where the container's persistent data (SQLite DB + report/trace storage) must be mounted. */
export const DATA_MOUNT = '/app/.data';

/** Endpoint every platform health check polls — it verifies database connectivity. */
export const HEALTH_PATH = '/api/health';

/** Port the container listens on unless `PORT` says otherwise. */
export const DEFAULT_PORT = 3000;

/** Default persistent-disk size: traces and HTML reports dominate the budget. */
export const DEFAULT_DISK_GB = 10;

/** Characters safe to leave unquoted in a dotenv value. */
const DOTENV_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a value for a `.env` file (also used for the systemd EnvironmentFile).
 * Values containing `$` prefer single quotes so dotenv/compose interpolation
 * can never rewrite them; everything else uses double quotes with `\`, `"` and
 * newline escapes. Simple values stay unquoted.
 */
export function quoteDotenvValue(value: string): string {
  if (value === '') return '';
  if (DOTENV_SAFE.test(value)) return value;
  if (value.includes('$') && !value.includes("'") && !value.includes('\n')) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Quote a value for POSIX shells: single quotes, embedded `'` as `'\''`. */
export function quoteShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a value for PowerShell: single quotes, embedded `'` doubled. */
export function quotePowershellValue(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`;
}

/**
 * Quote a value for YAML. Always quoted so `true`, `587` or `0.92` stay
 * strings; double-quoted style when escapes are needed, single-quoted
 * otherwise.
 */
export function quoteYamlValue(value: string): string {
  if (/[\n\t]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\n/g, '\\n')}"`;
  }
  return `'${value.replace(/'/g, `''`)}'`;
}

/** Quote a value for TOML: always a basic string, with the escapes TOML requires. */
export function quoteTomlValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

/**
 * Fully qualify an image reference the way Docker resolves it (`piwi/app` →
 * `docker.io/piwi/app`), which the platforms that pull by URL require. A first
 * segment carrying a dot, a port or `localhost` is already a registry host.
 */
export function qualifyImage(image: string): string {
  const first = image.split('/')[0] ?? '';
  const hasRegistry = image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  return hasRegistry ? image : `docker.io/${image}`;
}

/** Uppercase alphanumeric form of a name, for platforms that key magic variables off it. */
export function magicIdentifier(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Header lines as `#` comments, followed by a blank line. Shared by every `#`-commented format. */
export function commentBlock(header: readonly string[] | undefined): string {
  if (!header?.length) return '';
  return header.map((line) => `# ${line}`).join('\n') + '\n\n';
}
