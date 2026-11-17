/**
 * `GET /api/changelog` in the demo. The demo build copies `CHANGELOG.md` beside
 * the seed (`demo/changelog.md`, written by the `nitro:build:public-assets` hook
 * of nuxt.config.ts), and the handler pages it with the server's
 * `changelogPage`. The service worker knows no app version, so
 * `runningVersion` is empty, as the demo's `/api/version` names none.
 */
import { changelogPage, parseChangelog, type ChangelogPage, type ChangelogRelease } from '#shared/changelog';
import { getDemoDbBaseUrl } from '../db.client';

let releases: Promise<ChangelogRelease[] | null> | null = null;

async function readDemoChangelog(): Promise<ChangelogRelease[] | null> {
  const base = getDemoDbBaseUrl().replace(/\/$/, '');
  const response = await fetch(`${base}/demo/changelog.md`, { cache: 'no-cache' });
  if (!response.ok) return null;
  const parsed = parseChangelog(await response.text());
  return parsed.length ? parsed : null;
}

/** The demo's changelog, read once; a failed read is tried again on the next call. */
function demoChangelog(): Promise<ChangelogRelease[] | null> {
  releases ??= readDemoChangelog()
    .catch(() => null)
    .then((read) => {
      if (!read) releases = null;
      return read;
    });
  return releases;
}

export async function apiDemoChangelog(query?: URLSearchParams): Promise<ChangelogPage> {
  return changelogPage(await demoChangelog(), {
    runningVersion: '',
    cursor: query?.get('cursor') ?? undefined,
    limit: query?.get('limit') ?? undefined,
  });
}
