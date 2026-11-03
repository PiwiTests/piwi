import { afterEach, describe, expect, test, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { computed, ref } from 'vue';
import { shareLinksOffered } from '../../app/utils/share-links';
import { useShareLinksOffered, useShareLinksOfferedOnOpen } from '../../app/composables/useShareLinksOffered';

/**
 * Share links show only where they work: the instance turns them on, and the
 * dashboard is neither the desktop app nor the demo. The composables read the
 * instance's setting from `/api/share-links/settings`, with the Nuxt
 * auto-imports they call stubbed as globals.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubNuxt(where: { desktop: boolean; demo: boolean; answer: { enabled: boolean } | Error }) {
  const reads: string[] = [];
  const read = vi.fn(async (url: string) => {
    reads.push(url);
    if (where.answer instanceof Error) throw where.answer;
    return { ...where.answer, maxTtlDays: 30 };
  });
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useIsDesktop', () => where.desktop);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: where.demo } }));
  vi.stubGlobal('useRequestFetch', () => read);
  vi.stubGlobal('$fetch', read);
  vi.stubGlobal('useAsyncData', async (_key: string, handler: () => Promise<unknown>) => ({
    data: ref(await handler()),
  }));
  return { reads };
}

describe('shareLinksOffered', () => {
  test('offers share links where the instance enables them, in a browser', () => {
    expect(shareLinksOffered({ enabled: true, desktop: false, demo: false })).toBe(true);
  });

  test('offers none while share links are disabled', () => {
    expect(shareLinksOffered({ enabled: false, desktop: false, demo: false })).toBe(false);
  });

  test('offers none in the desktop app, enabled or not', () => {
    expect(shareLinksOffered({ enabled: true, desktop: true, demo: false })).toBe(false);
    expect(shareLinksOffered({ enabled: false, desktop: true, demo: false })).toBe(false);
  });

  test('offers none in the demo', () => {
    expect(shareLinksOffered({ enabled: true, desktop: false, demo: true })).toBe(false);
  });
});

describe('useShareLinksOffered', () => {
  test('offers share links when the server says they are enabled', async () => {
    const nuxt = stubNuxt({ desktop: false, demo: false, answer: { enabled: true } });
    expect((await useShareLinksOffered()).value).toBe(true);
    expect(nuxt.reads).toEqual(['/api/share-links/settings']);
  });

  test('offers none when the server says they are disabled', async () => {
    stubNuxt({ desktop: false, demo: false, answer: { enabled: false } });
    expect((await useShareLinksOffered()).value).toBe(false);
  });

  test('offers none when the settings cannot be read', async () => {
    stubNuxt({ desktop: false, demo: false, answer: new Error('401') });
    expect((await useShareLinksOffered()).value).toBe(false);
  });

  test('in the desktop app and the demo, offers none and reads nothing', async () => {
    for (const where of [
      { desktop: true, demo: false },
      { desktop: false, demo: true },
    ]) {
      const nuxt = stubNuxt({ ...where, answer: { enabled: true } });
      expect((await useShareLinksOffered()).value).toBe(false);
      expect(nuxt.reads).toEqual([]);
    }
  });
});

describe('useShareLinksOfferedOnOpen', () => {
  test('offers none until it loads, then follows the server, reading once', async () => {
    const nuxt = stubNuxt({ desktop: false, demo: false, answer: { enabled: true } });
    const { offered, load } = useShareLinksOfferedOnOpen();
    expect(offered.value).toBe(false);
    await load();
    await load();
    expect(offered.value).toBe(true);
    expect(nuxt.reads).toEqual(['/api/share-links/settings']);
  });

  test('offers none when share links are disabled or the read fails', async () => {
    stubNuxt({ desktop: false, demo: false, answer: { enabled: false } });
    const disabled = useShareLinksOfferedOnOpen();
    await disabled.load();
    expect(disabled.offered.value).toBe(false);

    stubNuxt({ desktop: false, demo: false, answer: new Error('401') });
    const failed = useShareLinksOfferedOnOpen();
    await failed.load();
    expect(failed.offered.value).toBe(false);
  });

  test('in the desktop app, offers none and reads nothing', async () => {
    const nuxt = stubNuxt({ desktop: true, demo: false, answer: { enabled: true } });
    const { offered, load } = useShareLinksOfferedOnOpen();
    await load();
    expect(offered.value).toBe(false);
    expect(nuxt.reads).toEqual([]);
  });
});

const APP_DIR = join(__dirname, '..', '..', 'app');

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return vueFiles(path);
    return path.endsWith('.vue') ? [path] : [];
  });
}

describe('every place that offers share links follows the rule', () => {
  const files = vueFiles(APP_DIR).map((path) => ({
    path: relative(APP_DIR, path),
    source: readFileSync(path, 'utf8'),
  }));

  test('each ShareLinksModal renders only where share links are offered', () => {
    const tags = files.flatMap(({ path, source }) =>
      [...source.matchAll(/<ShareLinksModal\b[^>]*>/g)].map((match) => ({ path, tag: match[0] })),
    );
    expect(tags.length).toBeGreaterThanOrEqual(4);
    for (const { path, tag } of tags) {
      expect(tag, path).toMatch(/v-if="[^"]*\boffersShareLinks\b[^"]*"/);
    }
  });

  test('each switch that puts a share link in a report or an issue follows the rule', () => {
    const owners = files.filter(({ source }) => /v-model="[^"]*\bincludeShareLink"/.test(source));
    expect(owners.length).toBeGreaterThanOrEqual(3);
    for (const { path, source } of owners) {
      expect(source, path).toMatch(/useShareLinksOffered(OnOpen)?\(\)/);
      expect(source, path).toMatch(/v-if="offersShareLinks"/);
    }
  });
});
