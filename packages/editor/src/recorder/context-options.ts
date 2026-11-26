/**
 * The browser a recording opens, from the `use` options Playwright resolved for one project: which browser and how
 * it launches, the options of its context, and the project's test id attribute. Pure: the launcher passes them to
 * `browserType.launch` and `browser.newContext` as they are.
 */
import * as path from 'node:path';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export interface RecorderBrowser {
  browserName: BrowserName;
  /** `browserType.launch`'s options: the project's `launchOptions` and `channel`, headed. */
  launchOptions: Record<string, unknown>;
  /** `browser.newContext`'s options. */
  contextOptions: Record<string, unknown>;
  /** The project's `testIdAttribute`; null for Playwright's default, `data-testid`. */
  testIdAttribute: string | null;
  /** What the recording should say about the options, in one sentence each: a sign-in state that is not there yet. */
  notes: string[];
}

/** The `use` options a recording's context gets, when the project sets them. */
const CONTEXT_OPTIONS = [
  'baseURL',
  'viewport',
  'deviceScaleFactor',
  'isMobile',
  'hasTouch',
  'userAgent',
  'locale',
  'timezoneId',
  'colorScheme',
  'reducedMotion',
  'forcedColors',
  'contrast',
  'storageState',
  'extraHTTPHeaders',
  'httpCredentials',
  'ignoreHTTPSErrors',
  'permissions',
  'geolocation',
  'proxy',
  'javaScriptEnabled',
  'bypassCSP',
  'serviceWorkers',
  'acceptDownloads',
] as const;

const BROWSERS: readonly BrowserName[] = ['chromium', 'firefox', 'webkit'];

/** The `--disable-features` switch and the Chromium feature whose translation bubble covers a page in another language. */
const DISABLE_FEATURES = '--disable-features=';
const TRANSLATE = 'Translate';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The project's `args` with Chromium's translation feature disabled, merged into a `--disable-features` it sets. */
function withTranslateDisabled(args: unknown): unknown[] {
  const list = Array.isArray(args) ? [...args] : [];
  const at = list.findIndex((arg) => typeof arg === 'string' && arg.startsWith(DISABLE_FEATURES));
  if (at < 0) return [...list, `${DISABLE_FEATURES}${TRANSLATE}`];
  const arg = list[at] as string;
  if (arg.slice(DISABLE_FEATURES.length).split(',').includes(TRANSLATE)) return list;
  list[at] = `${arg},${TRANSLATE}`;
  return list;
}

/**
 * The browser for a project's `use` options, as Playwright's fixtures read them: `browserName` (else the device's
 * `defaultBrowserType`, else Chromium), `launchOptions` with `channel` over it, `headless: false` unless
 * `headless` is asked for, and Chromium's translation feature disabled (its bubble covers the page while recording
 * one in another language); the context options of `contextOptions` with the project's own over them, `screen` only
 * with a viewport; a `storageState` file that does not exist (relative to `cwd`, the config's folder) is left out,
 * and said so.
 */
export function recorderBrowser(
  use: Record<string, unknown>,
  options: { cwd: string; headless: boolean; exists: (file: string) => boolean },
): RecorderBrowser {
  const named = [use.browserName, use.defaultBrowserType].find((b): b is BrowserName =>
    BROWSERS.includes(b as BrowserName),
  );
  const browserName = named ?? 'chromium';
  const launchOptions: Record<string, unknown> = isRecord(use.launchOptions) ? { ...use.launchOptions } : {};
  if (typeof use.channel === 'string' && use.channel) launchOptions.channel = use.channel;
  launchOptions.headless = options.headless;
  if (browserName === 'chromium') launchOptions.args = withTranslateDisabled(launchOptions.args);

  const contextOptions: Record<string, unknown> = {};
  const extra = isRecord(use.contextOptions) ? use.contextOptions : {};
  for (const key of CONTEXT_OPTIONS) {
    const value = use[key] !== undefined ? use[key] : extra[key];
    if (value !== undefined) contextOptions[key] = value;
  }
  const screen = use.screen !== undefined ? use.screen : extra.screen;
  if (isRecord(contextOptions.viewport) && screen !== undefined) contextOptions.screen = screen;

  const notes: string[] = [];
  const state = contextOptions.storageState;
  if (typeof state === 'string' && !options.exists(path.resolve(options.cwd, state))) {
    delete contextOptions.storageState;
    notes.push(`The sign-in state ${state} does not exist yet: run the setup project first.`);
  }

  const testIdAttribute = typeof use.testIdAttribute === 'string' && use.testIdAttribute ? use.testIdAttribute : null;
  return { browserName, launchOptions, contextOptions, testIdAttribute, notes };
}
