import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CAPABILITY_BY_ID } from '#shared/capabilities';
import { findGuideAnchor } from '#shared/guide-anchors/index.mjs';
import { isFixedPage } from '#shared/guide-stops';
import { isInstancePermission, isProjectPermission, rolesGranting, type Permission } from '#shared/permissions';
import { boldLabels, plainGuideText } from '~/utils/guide/markup';
import { revealQuery } from '~/utils/guide/stops';
import { AUTHORED_GUIDES } from '~/utils/guides/guides';
import { GUIDE_RESOLVERS, resolveGuideIds, type GuideApiGet, type GuideResolverId } from '~/utils/guides/resolvers';
import { authoredGuideRun, guideAvailable, stopPage } from '~/utils/guides/run';
import type { AuthoredGuideStop } from '~/utils/guides/types';
import { PAGE_FILES, PAGES, vueFiles } from './guide-anchor-source';

/**
 * The authored guides (`app/utils/guides/`) against the anchor registry, the
 * dashboard's source and the docs: every stop points at an anchor that renders
 * on the page it opens for the users the guide is listed for, its copy fits the
 * popover, and every dashboard label it puts in bold is spelled as the source
 * of its component or page spells it, so renaming the label fails here.
 */

const MIN_STOPS = 3;
const MAX_STOPS = 7;
const MAX_TITLE = 60;
const MAX_BODY = 360;
const MAX_SUMMARY = 80;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const STOPS = AUTHORED_GUIDES.flatMap((guide) =>
  guide.stops.map((stop, index) => ({ name: `${guide.id}/${stop.id}`, guide, stop, index })),
);

/** The files of the app that set each `data-tour`, by its value. */
const dataTourFiles = new Map<string, string[]>();
for (const { path, source } of vueFiles) {
  for (const match of source.matchAll(/(?<![:\w-])data-tour="([^"]*)"|'data-tour':\s*'([^']*)'/g)) {
    const value = match[1] ?? match[2]!;
    dataTourFiles.set(value, [...(dataTourFiles.get(value) ?? []), path]);
  }
}

const vueSource = new Map(vueFiles.map(({ path, source }) => [path, source]));
const componentFile = new Map(
  vueFiles.filter(({ path }) => path.startsWith('components/')).map(({ path }) => [basename(path, '.vue'), path]),
);

/**
 * The source a stop's bold labels may come from: the component setting its
 * anchor, the component whose tag carries the anchor (`<SectionCard
 * data-tour="…">`), and the files of the page the stop opens.
 */
function labelSources(stop: AuthoredGuideStop): string[] {
  const files = new Set<string>(dataTourFiles.get(stop.anchor) ?? []);
  for (const file of [...files]) {
    const tag = vueSource.get(file)!.match(new RegExp(`<([A-Z]\\w*)\\b[^<]*?data-tour="${stop.anchor}"`))?.[1];
    const component = tag ? componentFile.get(tag) : undefined;
    if (component) files.add(component);
  }
  for (const file of PAGE_FILES.get(stopPage(stop) ?? '') ?? []) files.add(file);
  return [...files].map((file) => vueSource.get(file)!);
}

/** Whether every role holding `held` holds `needed` too: an instance permission is an administrator's, who holds all. */
function implies(held: Permission | undefined, needed: Permission | undefined): boolean {
  if (!needed) return true;
  if (!held) return false;
  if (isInstancePermission(held)) return true;
  if (isInstancePermission(needed)) return false;
  const granting = rolesGranting(needed);
  return rolesGranting(held).every((role) => granting.includes(role));
}

describe('authored guides', () => {
  test('ids are unique and kebab-case', () => {
    const ids = AUTHORED_GUIDES.map((guide) => guide.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(ids.filter((id) => !KEBAB.test(id))).toEqual([]);
  });

  test.each(AUTHORED_GUIDES.map((guide) => [guide.id, guide] as const))('%s', (id, guide) => {
    expect(guide.stops.length, `${id}: stops`).toBeGreaterThanOrEqual(MIN_STOPS);
    expect(guide.stops.length, `${id}: stops`).toBeLessThanOrEqual(MAX_STOPS);
    const stopIds = guide.stops.map((stop) => stop.id);
    expect(
      stopIds.filter((s, i) => stopIds.indexOf(s) !== i || !KEBAB.test(s)),
      `${id}: stop ids used twice or not kebab-case`,
    ).toEqual([]);

    expect(guide.title.length, `${id}: title`).toBeLessThanOrEqual(MAX_TITLE);
    expect(guide.summary.length, `${id}: summary`).toBeLessThanOrEqual(MAX_SUMMARY);
    expect(guide.summary, `${id}: summary is one line`).not.toMatch(/[\n*<>]|\.$/);
    expect(guide.icon, `${id}: icon`).toMatch(/^i-lucide-[a-z0-9-]+$/);
    expect(guide.keywords.length, `${id}: keywords`).toBeGreaterThan(0);
    expect(
      guide.keywords.filter((keyword) => keyword !== keyword.trim() || !keyword),
      `${id}: keywords`,
    ).toEqual([]);

    const { capability, permission } = guide.requires;
    if (capability) expect(CAPABILITY_BY_ID[capability], `${id}: capability ${capability}`).toBeDefined();
    if (permission) {
      expect(isProjectPermission(permission) || isInstancePermission(permission), `${id}: ${permission}`).toBe(true);
    }
  });
});

describe('authored guide stops', () => {
  test('every stop points at a registry anchor that renders on a server, with a docs page', () => {
    const problems = STOPS.flatMap(({ name, stop }) => {
      const anchor = findGuideAnchor(stop.anchor);
      if (!anchor) return [`${name}: no anchor "${stop.anchor}"`];
      if (anchor.requires?.demo) return [`${name}: ${anchor.id} shows in the demo only`];
      if (anchor.requires?.desktop) return [`${name}: ${anchor.id} shows in the desktop app only`];
      if (!anchor.doc) return [`${name}: ${anchor.id} has no docs page`];
      return [];
    });
    expect(problems).toEqual([]);
  });

  test('a stop opens one of its anchor’s pages: a fixed one, or one its resolver fills', () => {
    const problems = STOPS.flatMap(({ name, stop }) => {
      const anchor = findGuideAnchor(stop.anchor);
      const page = stopPage(stop);
      if (!anchor || !page) return [];
      if (!anchor.pages.includes(page)) return [`${name}: ${page} is none of ${anchor.id}'s pages`];
      if (stop.resolve) {
        const resolver: { pages: readonly string[] } = GUIDE_RESOLVERS[stop.resolve];
        return resolver.pages.includes(page) ? [] : [`${name}: the ${stop.resolve} resolver does not fill ${page}`];
      }
      if (stop.page) return [`${name}: a page with no resolver`];
      return isFixedPage(page) ? [] : [`${name}: ${page} needs a resolver`];
    });
    expect(problems).toEqual([]);
  });

  test('its anchor renders for every user the guide is listed for', () => {
    const problems = STOPS.flatMap(({ name, guide, stop }) => {
      const requires = findGuideAnchor(stop.anchor)?.requires;
      if (requires?.capability && requires.capability !== guide.requires.capability) {
        return [`${name}: ${stop.anchor} needs the ${requires.capability} capability, the guide does not`];
      }
      if (!implies(guide.requires.permission, requires?.permission)) {
        return [`${name}: ${stop.anchor} needs ${requires?.permission}, which the guide's permission does not imply`];
      }
      return [];
    });
    expect(problems).toEqual([]);
  });

  // A page reads its query (`?tab=`, `?evidence=`) when it opens: a stop on the page
  // the guide is already on may drop query values, never add or change one.
  test('a stop on the page before it adds no query value', () => {
    const problems: string[] = [];
    for (const guide of AUTHORED_GUIDES) {
      let page: string | undefined;
      let query: Record<string, string> = {};
      for (const stop of guide.stops) {
        const next = revealQuery(findGuideAnchor(stop.anchor));
        if (stopPage(stop) !== page) {
          page = stopPage(stop);
          query = next;
          continue;
        }
        const changed = Object.entries(next).filter(([key, value]) => query[key] !== value);
        if (changed.length) problems.push(`${guide.id}/${stop.id}: ${changed.map(([k, v]) => `${k}=${v}`).join('&')}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test(`a title fits in ${MAX_TITLE} characters and a body in ${MAX_BODY}`, () => {
    const tooLong = STOPS.flatMap(({ name, stop }) => [
      ...(plainGuideText(stop.title).length > MAX_TITLE ? [`${name}: title ${plainGuideText(stop.title).length}`] : []),
      ...(plainGuideText(stop.body).length > MAX_BODY ? [`${name}: body ${plainGuideText(stop.body).length}`] : []),
    ]);
    expect(tooLong).toEqual([]);
  });

  test('**bold** is the only markup', () => {
    const marked = STOPS.flatMap(({ name, stop }) =>
      [stop.title, stop.body]
        .map((text) => text.replace(/\*\*(.+?)\*\*/g, '$1'))
        .filter((text) => /[*<>`[\]]/.test(text))
        .map((text) => `${name}: ${text}`),
    );
    expect(marked).toEqual([]);
  });

  test('every bold label is spelled as the source of the stop’s component or page spells it', () => {
    const missing = STOPS.flatMap(({ name, stop }) => {
      const sources = labelSources(stop);
      return boldLabels(`${stop.title} ${stop.body}`)
        .filter((label) => !sources.some((source) => source.includes(label)))
        .map((label) => `${name}: "${label}"`);
    });
    expect(missing).toEqual([]);
  });
});

describe('guide resolvers', () => {
  test('fill pages of the app', () => {
    const pages = Object.entries(GUIDE_RESOLVERS).flatMap(([id, resolver]) =>
      resolver.pages.filter((page) => !PAGES.has(page)).map((page) => `${id}: ${page}`),
    );
    expect(pages).toEqual([]);
  });

  /** A `get` answering each path from `routes`, recording the calls; a path it has no answer for fails. */
  function stubGet(routes: Record<string, unknown>) {
    const calls: string[] = [];
    const get: GuideApiGet = async <T>(path: string, query?: Record<string, string | number>) => {
      calls.push(
        query ? `${path}?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}` : path,
      );
      if (!(path in routes)) throw new Error(`404 ${path}`);
      return routes[path] as T;
    };
    return { get, calls };
  }

  const runs = {
    items: [
      { id: 7, status: 'running', startTime: '2026-10-22T12:00:00Z' },
      { id: 5, status: 'failed', startTime: '2026-10-22T10:00:00Z' },
      { id: 6, status: 'passed', startTime: '2026-10-22T10:00:00Z' },
      { id: 4, status: 'failed', startTime: '2026-10-22T09:00:00Z' },
    ],
  };
  const group = (executionId: number, locatorHealing: unknown = null) => ({ cases: [{ executionId }], locatorHealing });

  test('find the entity each one names', async () => {
    const { get } = stubGet({
      '/api/projects': { items: [{ id: 3 }, { id: 1 }] },
      '/api/test-runs/recent': runs,
      '/api/test-runs/5/failure-groups': { items: [group(51), group(52)] },
      '/api/test-runs/4/failure-groups': { items: [group(41), group(42, { recommended: "getByRole('button')" })] },
      '/api/failure-clusters': { items: [{ id: 10 }] },
      '/api/widgets/flaky-leaderboard': [
        { testCaseId: 9, projectId: 1 },
        { testCaseId: 53, projectId: 5 },
      ],
      '/api/dashboards': {
        items: [
          { id: 'overview', kind: 'builtin', canEdit: false },
          { id: 2, kind: 'saved', canEdit: false },
          { id: 1, kind: 'saved', canEdit: true },
        ],
      },
    });
    const ids = await resolveGuideIds(Object.keys(GUIDE_RESOLVERS) as GuideResolverId[], get);
    expect(ids).toEqual({
      project: 3,
      // The running run has no outcome yet; of the two started together, the higher id.
      'latest-run': 6,
      'failed-execution': 51,
      'locator-fix': 42,
      'open-cluster': 10,
      'flaky-test': 9,
      'flaky-project': 1,
      dashboard: 1,
    });
  });

  test('answer null when the instance holds nothing, or a route fails', async () => {
    const { get, calls } = stubGet({
      '/api/projects': { items: [] },
      '/api/test-runs/recent': { items: [{ id: 2, status: 'failed', startTime: null }] },
      '/api/test-runs/2/failure-groups': { items: [group(21)] },
      '/api/dashboards': { items: [{ id: 'overview', kind: 'builtin', canEdit: false }] },
    });
    const ids = await resolveGuideIds(['project', 'locator-fix', 'open-cluster', 'dashboard', 'project'], get);
    expect(ids).toEqual({ project: null, 'locator-fix': null, 'open-cluster': null, dashboard: null });
    expect(calls.filter((call) => call === '/api/projects')).toHaveLength(1);
    expect(calls).toContain('/api/failure-clusters?limit=1');
  });
});

describe('a guide run', () => {
  const guide = AUTHORED_GUIDES.find((g) => g.stops.some((s) => s.resolve) && g.stops.some((s) => !s.resolve))!;

  test('opens each resolved entity’s page, and shows a stop whose entity was not found centered', () => {
    const resolved = authoredGuideRun(guide, Object.fromEntries(guide.stops.map((s) => [s.resolve, 12])));
    const unresolved = authoredGuideRun(guide, {});
    guide.stops.forEach((stop, i) => {
      const anchor = findGuideAnchor(stop.anchor)!;
      expect(resolved.stops[i]).toMatchObject({ id: stop.id, anchor: stop.anchor, doc: anchor.doc });
      if (!stop.resolve) {
        expect(resolved.stops[i]!.route).toBeUndefined();
        expect(unresolved.stops[i]!.absent).toBeUndefined();
        return;
      }
      expect(resolved.stops[i]!.route).toBe(stopPage(stop)!.replace('[id]', '12'));
      expect(resolved.stops[i]!.absent).toBeUndefined();
      expect(unresolved.stops[i]).toMatchObject({ route: undefined, absent: true });
    });
    expect(resolved).toMatchObject({ id: `guide-${guide.id}`, lang: 'en' });
  });

  test('is listed only with its capability on and its permission held', () => {
    const configureAi = AUTHORED_GUIDES.find((g) => g.id === 'configure-ai')!;
    const viewer = { isHidden: () => false, holds: () => true };
    expect(guideAvailable(configureAi, viewer)).toBe(true);
    expect(guideAvailable(configureAi, { ...viewer, isHidden: (id) => id === 'ai' })).toBe(false);
    expect(guideAvailable(configureAi, { ...viewer, holds: (p) => p !== 'settings:manage' })).toBe(false);
  });
});

describe('the docs', () => {
  test('the Guides page lists every guide by its title', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/features/guides.md', import.meta.url)), 'utf8');
    expect(AUTHORED_GUIDES.map((guide) => guide.title).filter((title) => !page.includes(`**${title}**`))).toEqual([]);
  });
});
