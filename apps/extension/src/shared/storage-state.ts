/**
 * Playwright's `storageState` file from a tab's cookies and its origin's
 * `localStorage`, for Save login for tests. Pure: the login page hands it what
 * `chrome.cookies` and the page answered.
 */

import { quoteJsString } from '@piwitests/core/locator-chain';

/** A cookie as `chrome.cookies.getAll` answers it: the fields the file needs. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** `no_restriction`, `lax`, `strict` or `unspecified`. */
  sameSite: string;
  session: boolean;
  /** Seconds since the epoch; absent on a session cookie. */
  expirationDate?: number;
}

interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch, -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface StorageState {
  cookies: StorageStateCookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

/** Two-label public suffixes such as `co.uk` or `com.au`, which are no one's site. */
const SECOND_LEVEL_SUFFIX = /^(?:ac|co|com|edu|gov|net|org)\.[a-z]{2}$/;

/**
 * The host permissions that let `chrome.cookies` answer every cookie a page of
 * `hostname` is sent. The browser checks each cookie against the extension's
 * permissions by the cookie's domain alone, with no port and the scheme its
 * `Secure` flag implies, so the page's origin is not enough: the host goes in
 * for both schemes and any port, and so does each parent domain a cookie can
 * be set on (none for an IP address or a single-label host such as
 * `localhost`).
 */
export function cookieOriginPatterns(hostname: string): string[] {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const patterns = [`*://${host}/*`];
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return patterns;
  const labels = host.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const parent = labels.slice(i).join('.');
    if (SECOND_LEVEL_SUFFIX.test(parent)) break;
    patterns.push(`*://${parent}/*`);
  }
  return patterns;
}

/** Where the file goes in a project, as Playwright's authentication guide names it. */
const STORAGE_STATE_PATH = 'playwright/.auth/user.json';

/** `lax`, and `unspecified`, which Chromium treats as Lax, → `Lax`. */
function sameSiteOf(value: string): StorageStateCookie['sameSite'] {
  if (value === 'strict') return 'Strict';
  if (value === 'no_restriction') return 'None';
  return 'Lax';
}

export function toStorageState(
  cookies: readonly BrowserCookie[],
  origin: string,
  localStorage: ReadonlyArray<readonly [string, string]>,
): StorageState {
  const seen = new Set<string>();
  const out: StorageStateCookie[] = [];
  for (const cookie of cookies) {
    const key = `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.session || cookie.expirationDate === undefined ? -1 : Math.floor(cookie.expirationDate),
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: sameSiteOf(cookie.sameSite),
    });
  }
  const origins =
    localStorage.length > 0 ? [{ origin, localStorage: localStorage.map(([name, value]) => ({ name, value })) }] : [];
  return { cookies: out, origins };
}

/** The setup project's test that keeps the file up to date, for the dialog to offer. */
export function setupSnippet(path = STORAGE_STATE_PATH): string {
  return [
    '// auth.setup.ts',
    "import { test as setup } from '@playwright/test';",
    '',
    "setup('log in', async ({ page }) => {",
    '  // The login steps, or none: the saved file is enough until the session expires.',
    `  await page.context().storageState({ path: ${quoteJsString(path)} });`,
    '});',
    '',
    '// In a test file, or in the project’s `use`:',
    `test.use({ storageState: ${quoteJsString(path)} });`,
  ].join('\n');
}
