import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

/**
 * One home for SCM provider hosts and web URLs.
 *
 * Provider hostnames and the deep-link shapes live only in `shared/scm-urls.ts`;
 * provider API calls live only in `server/utils/scm/`. Anything that needs a
 * provider gets it from `createScmProvider` / `scmProviderForUrl`, and the
 * `ScmProviderName` union is never re-declared. These two scans keep it that way:
 * a new home for a provider host, URL or the union is a visible diff to the
 * allow-lists below.
 */

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCAN_ROOTS = ['server', 'shared', 'app', 'types'];

/** Provider host / API literals that belong only in the single-source modules. */
const HOST_LITERALS = ['api.github.com', 'github.com', 'gitlab.com', 'bitbucket.org'];

/**
 * Files and directory prefixes (repo-relative, posix) allowed to name a provider
 * host or web URL. A new entry here is the visible diff a reviewer must approve.
 */
const HOST_ALLOWLIST = [
  'shared/scm-urls.ts', // the single source of hosts + URL shapes
  'server/utils/scm/', // the provider factory and the three provider clients
  'server/utils/oauth.ts', // GitHub *login* OAuth — account, not repository access
  'shared/demo/', // canned demo data (fake acme/shop repositories)
  'app/demo/', // the in-browser demo mirror and its seeded data
];

/**
 * Substrings allowed to appear in any file — the project's own repository links
 * in the nav, about page, login page and demo banner, plus the example issue URL
 * shown as placeholder text in the "link an issue" input (not provider logic).
 */
const ALLOWED_SUBSTRINGS = ['github.com/piwitests/piwi', 'github.com/org/repo'];

/** The provider union — declared once in `shared/scm-urls.ts`, imported everywhere else. */
const UNION_RE = /'github'\s*\|\s*'gitlab'\s*\|\s*'bitbucket'/;
const UNION_ALLOWLIST = ['shared/scm-urls.ts'];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|vue)$/.test(name) || name.endsWith('.d.ts') || name.endsWith('.test.ts')) continue;
      out.push(full);
    }
  };
  for (const root of SCAN_ROOTS) {
    const dir = join(APP_ROOT, root);
    try {
      if (statSync(dir).isDirectory()) walk(dir);
    } catch {
      /* a root may not exist in every checkout */
    }
  }
  return out;
}

function isAllowed(relPath: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => (entry.endsWith('/') ? relPath.startsWith(entry) : relPath === entry));
}

describe('SCM provider hosts and URLs have a single source', () => {
  const files = sourceFiles();

  test('scans a meaningful set of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test('provider hosts and web URLs appear only in the allow-listed modules', () => {
    const violations: string[] = [];
    for (const file of files) {
      const relPath = relative(APP_ROOT, file).replaceAll('\\', '/');
      if (isAllowed(relPath, HOST_ALLOWLIST)) continue;

      let content = readFileSync(file, 'utf8');
      for (const allowed of ALLOWED_SUBSTRINGS) content = content.replaceAll(allowed, '');

      for (const literal of HOST_LITERALS) {
        if (content.includes(literal)) violations.push(`${relPath}: ${literal}`);
      }
    }
    expect(
      violations,
      `Move provider hosts/URLs into shared/scm-urls.ts or server/utils/scm/:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  test('the provider union is declared only in shared/scm-urls.ts', () => {
    const violations: string[] = [];
    for (const file of files) {
      const relPath = relative(APP_ROOT, file).replaceAll('\\', '/');
      if (isAllowed(relPath, UNION_ALLOWLIST)) continue;
      if (UNION_RE.test(readFileSync(file, 'utf8'))) violations.push(relPath);
    }
    expect(
      violations,
      `Import ScmProviderName from '#shared/scm-urls' instead of re-declaring the union:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
