import { afterEach, describe, expect, test, vi } from 'vitest';
import { version } from '../../package.json';

vi.mock('../../app/demo/db.client', () => ({ getDemoDbBaseUrl: () => 'https://example.test/demo/' }));

const { apiDemoChangelog } = await import('../../app/demo/api/changelog');

const CHANGELOG = [
  '## [0.2.0](https://x/compare) (2026-07-02)',
  '',
  '* **app:** add b',
  '',
  '## [0.1.0](https://x/compare) (2026-07-01)',
  '',
  '* **app:** add a',
  '',
].join('\n');

describe('the demo changelog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('pages the changelog copied beside the seed, and reads it again after a failed read', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(CHANGELOG));
    vi.stubGlobal('fetch', fetchMock);

    expect(await apiDemoChangelog(new URLSearchParams())).toEqual({
      runningVersion: version,
      total: 0,
      releases: [],
      nextCursor: null,
    });

    const page = await apiDemoChangelog(new URLSearchParams({ limit: '1' }));
    expect(page.total).toBe(2);
    expect(page.releases.map((release) => release.version)).toEqual(['0.2.0']);
    expect(page.nextCursor).toBe('0.2.0');

    const older = await apiDemoChangelog(new URLSearchParams({ cursor: '0.2.0' }));
    expect(older.releases.map((release) => release.version)).toEqual(['0.1.0']);
    expect(older.nextCursor).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/demo/demo/changelog.md', { cache: 'no-cache' });
  });
});
