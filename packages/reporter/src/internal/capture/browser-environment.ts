import type { Page, TestInfo } from '@playwright/test';
import { ENVIRONMENT_STRING_MAX, type WireBrowserEnvironment } from '@piwitests/core/wire';
import { ATTACHMENT_NAMES } from './attachments.js';
import { internalCall } from './quiet-capture.js';

/** What the page reports of itself: read in the page, so it holds no Node.js value. */
interface PageEnvironment {
  timeZone: string | null;
  locale: string | null;
  languages: string | null;
  formatSample: string | null;
  prefersColorScheme: string | null;
  prefersReducedMotion: string | null;
  screen: string | null;
  devicePixelRatio: number | null;
  userAgent: string | null;
}

/** Runs in the page: its time zone, locale, languages, how it formats by default and its media preferences. */
function readPageEnvironment(): PageEnvironment {
  const page = globalThis as unknown as {
    matchMedia(query: string): { matches: boolean };
    screen: { width: number; height: number };
    devicePixelRatio: number;
    navigator: { languages?: readonly string[]; language: string; userAgent: string };
  };
  const navigator = page.navigator;
  const safe = <T>(read: () => T): T | null => {
    try {
      return read() ?? null;
    } catch {
      return null;
    }
  };
  const options = safe(() => Intl.DateTimeFormat().resolvedOptions());
  const media = (query: string, values: string[]): string | null => {
    for (const value of values) if (safe(() => page.matchMedia(`(${query}: ${value})`).matches)) return value;
    return null;
  };
  return {
    timeZone: options?.timeZone ?? null,
    locale: options?.locale ?? null,
    languages: safe(() => (navigator.languages?.length ? navigator.languages.join(', ') : navigator.language)),
    formatSample: safe(
      () => `${new Intl.NumberFormat().format(1234.5)} · ${new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toLocaleString()}`,
    ),
    prefersColorScheme: media('prefers-color-scheme', ['dark', 'light']),
    prefersReducedMotion: media('prefers-reduced-motion', ['reduce', 'no-preference']),
    screen: safe(() => `${page.screen.width}×${page.screen.height}`),
    devicePixelRatio: safe(() => page.devicePixelRatio),
    userAgent: safe(() => navigator.userAgent),
  };
}

function cut(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > ENVIRONMENT_STRING_MAX ? trimmed.slice(0, ENVIRONMENT_STRING_MAX) : trimmed;
}

/** The projects of this worker whose browser was read already. */
const READ_PROJECTS = new Set<string>();

/** The snapshot read for the running test, attached as its capture is flushed. */
let pending: { testId: string; snapshot: WireBrowserEnvironment } | null = null;

/**
 * Read the browser's environment once per worker and project, from the test's page before the test navigates it;
 * `attachBrowserEnvironment` attaches it to that test as `piwi-environment` for the reporter. Off with
 * `PIWI_COLLECT_ENVIRONMENT_INFO=false`. A read that fails records nothing and is not tried again.
 */
export async function readBrowserEnvironment(page: Page, testInfo: TestInfo): Promise<void> {
  if (process.env.PIWI_COLLECT_ENVIRONMENT_INFO === 'false' || !testInfo?.project) return;
  const project = testInfo.project.name;
  if (READ_PROJECTS.has(project)) return;
  READ_PROJECTS.add(project);
  try {
    const observed = await internalCall(page, () => page.evaluate(readPageEnvironment));
    const use = testInfo.project.use as { browserName?: string; defaultBrowserType?: string; headless?: boolean };
    const browser = page.context().browser();
    const snapshot: WireBrowserEnvironment = {
      kind: 'browser',
      v: 1,
      project: cut(project) ?? '',
      browserName: cut(browser?.browserType().name() ?? use.browserName ?? use.defaultBrowserType),
      browserVersion: cut(browser?.version()),
      timeZone: cut(observed.timeZone),
      locale: cut(observed.locale),
      languages: cut(observed.languages),
      formatSample: cut(observed.formatSample),
      prefersColorScheme: cut(observed.prefersColorScheme),
      prefersReducedMotion: cut(observed.prefersReducedMotion),
      screen: cut(observed.screen),
      devicePixelRatio: typeof observed.devicePixelRatio === 'number' ? observed.devicePixelRatio : null,
      userAgent: cut(observed.userAgent),
      headless: typeof use.headless === 'boolean' ? use.headless : null,
    };
    pending = { testId: testInfo.testId, snapshot };
  } catch {
    /* a page that cannot be read records no browser snapshot */
  }
}

/** Attach the browser snapshot read for this test, if one was. */
export async function attachBrowserEnvironment(testInfo: TestInfo): Promise<void> {
  const read = pending;
  pending = null;
  if (!read || read.testId !== testInfo?.testId) return;
  await testInfo.attach(ATTACHMENT_NAMES.environment, {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(read.snapshot)),
  });
}
