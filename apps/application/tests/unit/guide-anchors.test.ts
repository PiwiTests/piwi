import { describe, expect, test } from 'vitest';
import { CAPABILITY_BY_ID } from '#shared/capabilities';
import { GUIDE_ANCHOR_BY_ID, GUIDE_ANCHORS } from '#shared/guide-anchors/index.mjs';
import { DEMO_USERS } from '~/demo/demo-users';
import { revealQuery, routeOnPage } from '~/utils/guide/stops';
import { PAGES, sentenceProblem, vueFiles } from './guide-anchor-source';

/**
 * The guide anchor registry (`shared/guide-anchors/`) against the dashboard's
 * source: every anchor is the static `data-tour` attribute of one element and
 * every such attribute is an anchor; its pages are pages of the app, its reveal
 * names anchors of the same page, its sample opens one of its pages with every
 * query the reveal needs, and its sentences fit.
 */

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Each static `data-tour` value in the app's components, with the file of each
 * element that sets it: a template's `data-tour="…"`, or the `'data-tour': '…'`
 * key of an item a component passes to a menu (a sidebar or menu entry).
 */
const dataTourFiles = new Map<string, string[]>();
for (const { path, source } of vueFiles) {
  for (const match of source.matchAll(/(?<![:\w-])data-tour="([^"]*)"|'data-tour':\s*'([^']*)'/g)) {
    const value = match[1] ?? match[2]!;
    dataTourFiles.set(value, [...(dataTourFiles.get(value) ?? []), path]);
  }
}

describe('guide anchor ids', () => {
  test('are unique and kebab-case', () => {
    const ids = GUIDE_ANCHORS.map((anchor) => anchor.id);
    expect(
      ids.filter((id, i) => ids.indexOf(id) !== i),
      'anchor ids used twice',
    ).toEqual([]);
    expect(GUIDE_ANCHOR_BY_ID.size).toBe(GUIDE_ANCHORS.length);
    expect(
      ids.filter((id) => !KEBAB.test(id)),
      'anchor ids that are not kebab-case',
    ).toEqual([]);
  });

  test('every anchor is the data-tour of exactly one element', () => {
    const problems = GUIDE_ANCHORS.flatMap(({ id }) => {
      const files = dataTourFiles.get(id) ?? [];
      return files.length === 1 ? [] : [`${id}: set on ${files.length} elements (${files.join(', ')})`];
    });
    expect(problems).toEqual([]);
  });

  test('every data-tour in the app is an anchor', () => {
    expect(
      [...dataTourFiles.keys()].filter((value) => !GUIDE_ANCHOR_BY_ID.has(value)),
      'data-tour values the registry does not list',
    ).toEqual([]);
  });

  test('every data-tour is a static, kebab-case value', () => {
    expect([...dataTourFiles.keys()].filter((value) => !KEBAB.test(value))).toEqual([]);
    const bound = vueFiles.filter(({ source }) =>
      /(?<![\w-])(?:v-bind)?:data-tour\b|['"]data-tour['"]\s*:\s*(?=\S)(?!'[^']*'\s*[,}\n])/.test(source),
    );
    expect(
      bound.map(({ path }) => path),
      'a bound data-tour cannot be found in the source',
    ).toEqual([]);
  });
});

describe('guide anchors', () => {
  test('the app’s pages are read', () => {
    expect(PAGES.has('/')).toBe(true);
    expect(PAGES.has('/projects/[id]')).toBe(true);
    expect(PAGES.has('/settings/notifications')).toBe(true);
  });

  test.each(GUIDE_ANCHORS.map((anchor) => [anchor.id, anchor] as const))('%s', (id, anchor) => {
    const { pages, reveal = [], sample, requires } = anchor;

    expect(pages.length, `${id}: pages`).toBeGreaterThan(0);
    expect(
      pages.filter((page) => page !== '*' && !PAGES.has(page)),
      `${id}: pages with no file under app/pages`,
    ).toEqual([]);
    if (pages.includes('*')) expect(pages, `${id}: '*' stands alone`).toEqual(['*']);

    for (const step of reveal) {
      const named = 'unfold' in step ? step.unfold : 'open' in step ? step.open : null;
      if (named === null) continue;
      const holder = GUIDE_ANCHOR_BY_ID.get(named);
      expect(holder, `${id}: its reveal names "${named}", which is not an anchor`).toBeDefined();
      expect(named, `${id}: its reveal names itself`).not.toBe(id);
      const shared = holder!.pages.includes('*') || holder!.pages.some((page) => pages.includes(page));
      expect(shared, `${id}: its reveal names "${named}", which is on none of its pages`).toBe(true);
    }

    const onPage = pages.includes('*')
      ? [...PAGES].some((page) => routeOnPage(sample.route, page))
      : pages.some((page) => routeOnPage(sample.route, page));
    expect(onPage, `${id}: the sample route ${sample.route} opens none of its pages`).toBe(true);
    const query = new URLSearchParams(sample.route.split('?')[1]?.split('#')[0] ?? '');
    for (const [key, value] of Object.entries(revealQuery(anchor))) {
      expect(query.get(key), `${id}: the sample route ${sample.route} selects ${key}=${value}`).toBe(value);
    }
    if (sample.persona !== undefined) {
      expect(
        DEMO_USERS.some((user) => user.id === sample.persona),
        `${id}: persona ${sample.persona} is a demo user`,
      ).toBe(true);
    }

    expect(sentenceProblem(anchor.describes), `${id}: describes`).toBeNull();
    if (anchor.shownWhen !== undefined) expect(sentenceProblem(anchor.shownWhen), `${id}: shownWhen`).toBeNull();

    if (requires?.capability) {
      expect(CAPABILITY_BY_ID[requires.capability], `${id}: capability ${requires.capability}`).toBeDefined();
    }
    if (requires?.demo) {
      expect(
        (dataTourFiles.get(id) ?? []).every((path) => path.startsWith('components/demo/')),
        `${id}: a demo-only anchor is set in a component under app/components/demo/`,
      ).toBe(true);
    }
  });
});
