// The browser `piwi-turbo`'s spare worker launches while the runner starts: the headless Chromium the last run's first
// worker launched, with the same options. The worker's first launch takes it when it asks for those options and the
// environment variables the browser reads are those it was launched with; otherwise the early browser is closed and
// the worker launches its own.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCacheRoot, privateFolder } from './cache-folder';

/** The launch options an early browser may be launched with: none of them can carry a credential. */
const LAUNCH_KEYS = new Set([
  'headless',
  'channel',
  'executablePath',
  'args',
  'ignoreDefaultArgs',
  'chromiumSandbox',
  'handleSIGINT',
  'handleSIGTERM',
  'handleSIGHUP',
  'timeout',
  'slowMo',
  'tracesDir',
  'artifactsDir',
  'downloadsPath',
]);

/**
 * The environment variables a browser and the processes it starts read (time zone and locale, home and temporary
 * folders, display, fonts, proxies, certificates, the program and library paths, Chromium's own), and those that change
 * how Playwright finds, launches or debugs it.
 */
const BROWSER_ENV =
  /^(TZ|LANG|LANGUAGE|LC_\w+|HOME|USER|LOGNAME|PATH|TMPDIR|TEMP|TMP|XDG_\w+|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_\w+|FONTCONFIG_\w+|FC_\w+|GTK_\w+|QT_\w+|\w*_PROXY|SSL_\w+|NSS_\w+|CHROME_\w+|CHROMIUM_\w+|GOOGLE_\w+|LD_\w+|MESA_\w+|LIBGL_\w+|PLAYWRIGHT_(BROWSERS_PATH|HOST_PLATFORM_OVERRIDE|DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK|PROXY_BYPASS_FOR_TESTING|SKIP_VALIDATE_HOST_REQUIREMENTS)|PW_CHROMIUM_\w+|PWDEBUG\w*|PW_DEBUG_CONTROLLER_HEADLESS|DEBUG)$/i;

/** Set on a browser the worker took from the spare. */
export const EARLY_BROWSER = Symbol.for('piwi-turbo.early-browser');

/** How long a handed-off worker keeps an early browser its first launch has not taken. */
const UNUSED_MS = 60_000;

type LaunchOptions = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Playwright's client classes, untyped here
type Client = any;

/** What the last run's first worker launched, as recorded for the next run. */
interface Launched {
  options: LaunchOptions;
}

/** An early browser on its way. */
export interface EarlyBrowser {
  options: LaunchOptions;
  env: Record<string, string>;
  browser: Promise<Client | undefined>;
}

type Log = ((message: string) => void) | undefined;

/** `options` when an early browser may be launched with them: headless, and only keys that hold no credential. */
export function launchableOptions(options: LaunchOptions): LaunchOptions | undefined {
  if (options.headless === false || options.devtools) return undefined;
  for (const [key, value] of Object.entries(options))
    if (value !== undefined && !LAUNCH_KEYS.has(key)) return undefined;
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

/** The variables of `env` the browser reads. */
export function browserEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value !== undefined && BROWSER_ENV.test(key)) picked[key] = value;
  }
  return picked;
}

/** Why an early browser cannot stand in for a launch, or `undefined` when it can. */
export function earlyBrowserRefusal(
  early: Pick<EarlyBrowser, 'options' | 'env'>,
  browserName: string,
  options: LaunchOptions | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (browserName !== 'chromium') return `the worker launches ${browserName}`;
  if (!options) return 'the worker launches with options an early browser does not take';
  if (JSON.stringify(options) !== JSON.stringify(early.options)) return 'the launch options changed';
  const now = browserEnv(env);
  for (const key of new Set([...Object.keys(now), ...Object.keys(early.env)]))
    if (now[key] !== early.env[key]) return `${key} changed`;
  return undefined;
}

/** The file that records the first worker's launch for runs from `cwd`, in a folder only this user can write to. */
function recordFile(cwd: string): string | undefined {
  const folder = join(defaultCacheRoot(), 'early-browser');
  if (!privateFolder(folder)) return undefined;
  return join(folder, `${createHash('sha1').update(cwd).digest('hex').slice(0, 16)}.json`);
}

function readLaunched(cwd: string): Launched | undefined {
  const file = recordFile(cwd);
  if (!file) return undefined;
  try {
    const launched = JSON.parse(readFileSync(file, 'utf8')) as Partial<Launched>;
    return launched.options && typeof launched.options === 'object' ? { options: launched.options } : undefined;
  } catch {
    return undefined;
  }
}

function writeLaunched(cwd: string, launched: Launched): void {
  const file = recordFile(cwd);
  if (!file) return;
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(launched), { mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    // The next run launches no early browser.
  }
}

/**
 * Launches the browser the last run's first worker launched from this folder, if any. Its environment is read as it
 * launches, once the load that called this has returned.
 */
export function startEarlyBrowser(coreDir: string): EarlyBrowser | undefined {
  const launched = readLaunched(process.cwd());
  const options = launched && launchableOptions(launched.options);
  if (!options) return undefined;
  const playwright: Client = require(join(coreDir, 'index.js'));
  const early: EarlyBrowser = { options, env: {}, browser: Promise.resolve(undefined) };
  early.browser = Promise.resolve()
    .then(() => {
      early.env = browserEnv(process.env);
      return playwright.chromium.launch(options);
    })
    .catch(() => undefined);
  return early;
}

/**
 * Called once the spare is handed off: the worker's first launch takes `early` when it can, and records what it
 * launched for the next run. An early browser no launch took is closed after a while.
 */
export function adoptEarlyBrowser(coreDir: string, early: EarlyBrowser | undefined, log: Log): void {
  const playwright: Client = require(join(coreDir, 'index.js'));
  const proto = Object.getPrototypeOf(playwright.chromium);
  const launch = proto.launch as (options?: LaunchOptions) => Promise<Client>;
  let pending = early;
  const closeUnused = () => {
    const unused = pending;
    pending = undefined;
    void unused?.browser.then((browser) => browser?.close()).catch(() => {});
  };
  if (pending) setTimeout(closeUnused, UNUSED_MS).unref();
  let recorded = false;
  proto.launch = async function (this: Client, options: LaunchOptions = {}) {
    const name = this.name() as string;
    const effective = launchableOptions({ ...this._playwright._defaultLaunchOptions, ...options });
    if (!recorded) {
      recorded = true;
      if (name === 'chromium' && effective) writeLaunched(process.cwd(), { options: effective });
    }
    const candidate = pending;
    pending = undefined;
    if (candidate) {
      const refusal = earlyBrowserRefusal(candidate, name, effective, process.env);
      const browser = refusal ? undefined : await candidate.browser;
      if (browser?.isConnected()) {
        browser[EARLY_BROWSER] = true;
        log?.('early browser taken by the first launch');
        return browser;
      }
      log?.(`early browser not used: ${refusal ?? 'it did not start'}`);
      void candidate.browser.then((unused) => unused?.close()).catch(() => {});
    }
    return launch.call(this, options);
  };
}
