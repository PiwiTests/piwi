import * as fs from 'node:fs';
import * as os from 'node:os';
import { ENVIRONMENT_STRING_MAX, type WireRunnerEnvironment } from '@piwitests/core/wire';

type Env = Record<string, string | undefined>;

/** What the runner snapshot reads of the machine and the process: the real ones by default, stand-ins in tests. */
export interface RunnerSystem {
  platform(): string;
  release(): string;
  /** `os.version()` where it exists. */
  version(): string | null;
  arch(): string;
  hostname(): string;
  cpuModel(): string | null;
  cores(): number;
  totalMemory(): number;
  nodeVersion: string;
  icuVersion: string | null;
  /** The contents of `/etc/os-release`, null when absent. */
  osRelease(): string | null;
  /** True when `/.dockerenv` exists. */
  dockerEnv(): boolean;
  /** `Intl.DateTimeFormat().resolvedOptions()`'s time zone and locale. */
  intl(): { timeZone: string | null; locale: string | null };
  /** Minutes east of UTC now. */
  utcOffsetMinutes(): number;
}

function readFileOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export const realRunnerSystem: RunnerSystem = {
  platform: () => os.platform(),
  release: () => os.release(),
  version: () => (typeof os.version === 'function' ? os.version() : null),
  arch: () => os.arch(),
  hostname: () => os.hostname(),
  cpuModel: () => os.cpus()[0]?.model?.trim() || null,
  cores: () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length),
  totalMemory: () => os.totalmem(),
  nodeVersion: process.version,
  icuVersion: process.versions.icu ?? null,
  osRelease: () => readFileOrNull('/etc/os-release'),
  dockerEnv: () => fs.existsSync('/.dockerenv'),
  intl: () => {
    const options = Intl.DateTimeFormat().resolvedOptions();
    return { timeZone: options.timeZone || null, locale: options.locale || null };
  },
  utcOffsetMinutes: () => -new Date().getTimezoneOffset(),
};

function cut(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > ENVIRONMENT_STRING_MAX ? trimmed.slice(0, ENVIRONMENT_STRING_MAX) : trimmed;
}

/** The `PRETTY_NAME` of an `/etc/os-release` file, null without one. */
export function prettyName(osRelease: string | null): string | null {
  if (!osRelease) return null;
  const match = osRelease.match(/^PRETTY_NAME=(.*)$/m);
  if (!match?.[1]) return null;
  return match[1].trim().replace(/^["']|["']$/g, '') || null;
}

/** The kernel's major and minor version: `6.8.0-1017-azure` gives `6.8`. */
function shortRelease(release: string): string {
  return release.match(/^(\d+\.\d+)/)?.[1] ?? release;
}

/** Platform, kernel release and the Linux distribution (or the OS version elsewhere). */
export function describeOs(system: RunnerSystem): string | null {
  const platform = system.platform();
  const release = shortRelease(system.release());
  const detail = platform === 'linux' ? prettyName(system.osRelease()) : system.version();
  return cut(detail ? `${platform} ${release} · ${detail}` : `${platform} ${release}`);
}

/**
 * The CI runner image, read in the provider order `collectCiInfo` uses: the hosted image of GitHub Actions and Azure
 * Pipelines (`ImageOS` and `ImageVersion`), GitHub's runner OS and architecture, GitLab's runner version and tags.
 * Null elsewhere.
 */
export function ciImage(env: Env): string | null {
  const join = (...parts: Array<string | undefined>) => cut(parts.filter((p) => p?.trim()).join(' ')) ?? null;
  if (env.JENKINS_URL) return null;
  if (env.GITHUB_ACTIONS) {
    const image = join(env.ImageOS, env.ImageVersion);
    return image ?? join(env.RUNNER_OS, env.RUNNER_ARCH);
  }
  if (env.GITLAB_CI) {
    const version = env.CI_RUNNER_VERSION?.trim();
    const tags = env.CI_RUNNER_TAGS?.trim();
    return join(version ? `runner ${version}` : undefined, tags ? `tags ${tags}` : undefined);
  }
  if (env.TF_BUILD) return join(env.ImageOS, env.ImageVersion);
  return null;
}

/** `docker` when `/.dockerenv` exists, `kubernetes` with `KUBERNETES_SERVICE_HOST`, else null. */
export function detectContainer(env: Env, system: Pick<RunnerSystem, 'dockerEnv'>): string | null {
  if (env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
  try {
    if (system.dockerEnv()) return 'docker';
  } catch {
    /* unreadable: not recorded */
  }
  return null;
}

/** The locale variables that are set, as `NAME=value` joined by spaces. */
export function langVariables(env: Env): string | null {
  const set = ['LANG', 'LC_ALL', 'LC_TIME']
    .filter((name) => env[name]?.trim())
    .map((name) => `${name}=${env[name]!.trim()}`);
  return cut(set.join(' '));
}

function attempt<T>(read: () => T): T | null {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

/**
 * The runner snapshot: where Playwright and this reporter run. Reads a closed list of fields; no environment variable
 * is copied whole. A field that cannot be read is null.
 */
export function collectRunnerEnvironment(
  env: Env,
  shardIndex: number | null,
  system: RunnerSystem = realRunnerSystem,
): WireRunnerEnvironment {
  const intl = attempt(() => system.intl());
  const memory = attempt(() => system.totalMemory());
  return {
    kind: 'runner',
    v: 1,
    shardIndex,
    timeZone: cut(intl?.timeZone),
    utcOffsetMinutes: attempt(() => system.utcOffsetMinutes()),
    tzVariable: cut(env.TZ),
    locale: cut(intl?.locale),
    langVariables: langVariables(env),
    os: attempt(() => describeOs(system)),
    arch: cut(attempt(() => system.arch())),
    nodeVersion: cut(system.nodeVersion),
    icuVersion: cut(system.icuVersion),
    ciImage: ciImage(env),
    container: detectContainer(env, system),
    cpuModel: cut(attempt(() => system.cpuModel())),
    cores: attempt(() => system.cores()),
    memoryBytes: memory && memory > 0 ? memory : null,
    hostname: cut(attempt(() => system.hostname())),
  };
}
