import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(here, '..', '..', 'dist');

/** An already-installed Chromium to use instead of the revision Playwright pins — see application/playwright.config.ts's own copy of this. Extensions need the full browser, not the headless-shell variant `--only-shell` installs, so CI installs plain `chromium` here and leaves this unset. */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim() || '';

/** `fr` → `LANGUAGE=fr`, `LANG=fr_FR.UTF-8`, `--lang=fr` and `locale: 'fr'`. */
function languageLaunchOptions(language: string): {
  options: { env: Record<string, string>; locale: string };
  args: string[];
} {
  const [lang, region = lang] = language.split('-') as [string, string?];
  const posix = `${lang}_${region.toUpperCase()}`;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1]));
  return {
    options: { env: { ...env, LANGUAGE: language.replace('-', '_'), LANG: `${posix}.UTF-8` }, locale: language },
    args: [`--lang=${language}`],
  };
}

/**
 * Launches Chromium with the extension at `extensionPath` loaded, by default
 * the built `dist/`. The `context` fixture uses it; a spec that must change the
 * extension's files on disk while it runs loads a copy of `dist/` instead.
 *
 * `developerMode` turns on the extensions page's Developer mode in the new
 * profile, as it is for anyone who loads the extension unpacked. A spec that
 * reloads the extension needs it: without it, Chromium does not enable the
 * reloaded copy again.
 *
 * `args` adds command-line switches, and `userDataDir` names the profile
 * directory, for a spec that reads files the browser writes there.
 *
 * `language` runs the browser in another language (`fr`). On Linux the
 * `--lang` flag alone makes `chrome.i18n.getMessage` answer in that language
 * but leaves `getUILanguage()` at `en-US`. Launched by hand, the `LANGUAGE`
 * environment variable makes both agree; under Playwright Test the context's
 * `locale`, which the runner otherwise sets to `en-US`, decides instead. Both
 * are set.
 */
export async function launchWithExtension(
  extensionPath = EXTENSION_PATH,
  opts: {
    developerMode?: boolean;
    language?: string;
    args?: string[];
    userDataDir?: string;
    /** Renders at this scale, for an illustration captured crisp. */
    deviceScaleFactor?: number;
  } = {},
): Promise<BrowserContext> {
  const userDataDir = opts.userDataDir ?? mkdtempSync(path.join(tmpdir(), 'piwi-picker-e2e-'));
  if (opts.developerMode) {
    mkdirSync(path.join(userDataDir, 'Default'));
    writeFileSync(
      path.join(userDataDir, 'Default', 'Preferences'),
      JSON.stringify({ extensions: { ui: { developer_mode: true } } }),
    );
  }
  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    ...(opts.args ?? []),
  ];
  const language = opts.language ? languageLaunchOptions(opts.language) : { options: {}, args: [] };
  const scale = opts.deviceScaleFactor ? { deviceScaleFactor: opts.deviceScaleFactor } : {};
  // Playwright's own docs example for extensions uses `channel: 'chromium'`
  // with no `headless` option and no manual `--headless=new`: with
  // `headless: true` + `--headless=new`, CI hangs waiting for the extension's
  // service worker to register (see extensionWorker below), a known class of
  // upstream reports for extensions in CI/Docker. `executablePath` and
  // `channel` are mutually exclusive, so the local sandbox override keeps its
  // own launch options.
  return chromium.launchPersistentContext(
    userDataDir,
    chromiumExecutable
      ? {
          ...language.options,
          ...scale,
          executablePath: chromiumExecutable,
          args: [...args, ...language.args, '--headless=new'],
        }
      : { ...language.options, ...scale, channel: 'chromium', args: [...args, ...language.args] },
  );
}

/** The extension's service worker, once it has registered. */
export async function extensionWorker(context: BrowserContext): Promise<Worker> {
  // Not a check-then-await-the-event pattern: the service worker can
  // register in the gap between checking serviceWorkers() and attaching
  // a waitForEvent listener, missing the event entirely and hanging until
  // timeout. Polling re-checks the live state instead, so there's no gap
  // to lose the registration in.
  const deadline = Date.now() + 45_000;
  let sw = context.serviceWorkers()[0];
  while (!sw && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    sw = context.serviceWorkers()[0];
  }
  if (!sw) throw new Error("the extension's service worker never registered within 45s");
  return sw;
}

/**
 * Opens the settings page (`hash` such as `#add=…`) and waits for {@link optionsReady}: `goto` resolves on `load`,
 * which can come before `src/options/main.ts` has finished its top-level awaits and attached its listeners.
 */
export async function openOptions(page: Page, extensionId: string, hash = ''): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/options.html${hash}`);
  await optionsReady(page);
}

/** Waits until the settings page marks `html[data-ready]`, once every listener is attached; after a `reload()` too. */
export async function optionsReady(page: Page): Promise<void> {
  await page.locator('html[data-ready]').waitFor({ state: 'attached' });
}

export const test = base.extend<{ context: BrowserContext; extensionId: string; browserLanguage: string | undefined }>({
  /** The browser's language, `test.use({ browserLanguage: 'fr' })`; the default is the system's, English in CI. */
  browserLanguage: [undefined, { option: true }],

  context: async ({ browserLanguage }, use) => {
    const context = await launchWithExtension(undefined, { language: browserLanguage });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    await use((await extensionWorker(context)).url().split('/')[2]!);
  },
});

export const expect = test.expect;
