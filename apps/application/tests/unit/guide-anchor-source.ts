/**
 * The dashboard's source as the guide anchor tests read it: its `.vue` files,
 * its pages, the pages each component renders on, and the items the coverage
 * rules ask an anchor for (`guide-anchor-coverage.test.ts`), each in the area
 * of the dashboard whose file of `shared/guide-anchors/` covers it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUIDE_AREAS,
  type GuideAnchor,
  type GuideAreaId,
  type GuideCoverageRule,
} from '#shared/guide-anchors/index.mjs';
import { HELP_TOPICS } from '~/utils/help-content';
import { SETTINGS_PAGES } from '~/utils/settings-metadata';
import { revealQuery } from '~/utils/guide/stops';

const appDir = fileURLToPath(new URL('../../app', import.meta.url));

/** The source of a file of the app, by its path from `app/`. */
export function appSource(path: string): string {
  return readFileSync(join(appDir, path), 'utf8');
}

/** Every `.vue` file of the app, by its path from `app/` with `/` separators. */
export const vueFiles = (readdirSync(appDir, { recursive: true }) as string[])
  .filter((path) => path.endsWith('.vue'))
  .map((path) => path.split(sep).join('/'))
  .sort()
  .map((path) => ({ path, source: appSource(path) }));

/** The pattern of a file of `app/pages`: `pages/index.vue` is `/`, `pages/projects/[id]/index.vue` is `/projects/[id]`. */
export function pageOfFile(path: string): string {
  return `/${path.slice('pages/'.length, -'.vue'.length).replace(/(^|\/)index$/, '')}`;
}

/** Every page of `app/pages` as a pattern, with its files: `settings.vue` and `settings/index.vue` are both `/settings`. */
export const PAGE_FILES = new Map<string, string[]>();
for (const { path } of vueFiles.filter(({ path }) => path.startsWith('pages/'))) {
  PAGE_FILES.set(pageOfFile(path), [...(PAGE_FILES.get(pageOfFile(path)) ?? []), path]);
}
export const PAGES = new Set(PAGE_FILES.keys());

export const MAX_SENTENCE = 160;

/** Why `text` is not one sentence of at most `MAX_SENTENCE` characters, or null when it is. */
export function sentenceProblem(text: string): string | null {
  if (text.length > MAX_SENTENCE) return `${text.length} characters, over ${MAX_SENTENCE}`;
  if (!/^[A-Z].*\.$/.test(text)) return 'it does not start with a capital and end with a period';
  if (/[.!?]\s/.test(text)) return 'more than one sentence';
  return null;
}

// ── Where each component renders ───────────────────────────────────────────

/** Each component's file by its name: a component is named by its file name alone (`pathPrefix: false`). */
const componentFiles = new Map(
  vueFiles.filter(({ path }) => path.startsWith('components/')).map(({ path }) => [basename(path, '.vue'), path]),
);

/** The component files `names` name. */
function componentsNamed(names: Iterable<string>): string[] {
  return [...names].flatMap((name) => componentFiles.get(name) ?? []);
}

/**
 * The components a `.vue` file renders: its `<Name>` and `<LazyName>` tags, and
 * the components a util or composable it imports names, such as the analytics
 * widget map.
 */
function rendersOf(source: string): Set<string> {
  const names = [...source.matchAll(/<(?:Lazy)?([A-Z][A-Za-z0-9]*)/g)].map((match) => match[1]!);
  for (const [, module] of source.matchAll(/from '~\/((?:utils|composables)\/[\w/-]+)'/g)) {
    const path = `${module}.ts`;
    if (existsSync(join(appDir, path))) names.push(...(appSource(path).match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? []));
  }
  return new Set(componentsNamed(names));
}

const renders = new Map(vueFiles.map(({ path, source }) => [path, rendersOf(source)]));

/** The page patterns each `.vue` file renders on; `*` for the app shell and the layouts, on every page. */
export const PAGES_OF_FILE = new Map<string, string[]>();
for (const { path } of vueFiles) {
  const root = path.startsWith('pages/') ? pageOfFile(path) : /^(?:app|layouts\/\w+)\.vue$/.test(path) ? '*' : null;
  if (root === null) continue;
  const seen = new Set<string>();
  const stack = [path];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const pages = PAGES_OF_FILE.get(file) ?? [];
    if (!pages.includes(root)) PAGES_OF_FILE.set(file, [...pages, root]);
    stack.push(...(renders.get(file) ?? []));
  }
}

// ── Areas ──────────────────────────────────────────────────────────────────

export const AREA_IDS: readonly GuideAreaId[] = GUIDE_AREAS.map((area) => area.id);

/** The area of each page, by its pattern: the first rule that matches, else `setup`. */
const PAGE_AREAS: readonly [RegExp, GuideAreaId][] = [
  [/^\/$/, 'home'],
  [/^\/projects\/\[id\]\/(?:import|bug-reports)$/, 'setup'],
  [/^\/projects(?:\/|$)/, 'projects'],
  [/^\/test-runs\//, 'runs'],
  [/^\/test-run-cases\//, 'executions'],
  [/^\/failure-clusters\//, 'clusters'],
  [/^\/test-cases\//, 'test-cases'],
  [/^\/(?:analytics|reports)(?:\/|$)/, 'analytics'],
  [/^\/settings(?:\/|$)/, 'settings'],
];

export function pageArea(page: string): GuideAreaId {
  if (page === '*') return 'layout';
  return PAGE_AREAS.find(([pattern]) => pattern.test(page))?.[1] ?? 'setup';
}

/** The area of the components of each directory of `app/components/`; `shared/` goes by where each renders. */
export const COMPONENT_DIR_AREAS: Readonly<Record<string, GuideAreaId>> = {
  analytics: 'analytics',
  'bug-reports': 'setup',
  cluster: 'clusters',
  'combined-coverage': 'projects',
  demo: 'demo',
  desktop: 'layout',
  diagnosis: 'clusters',
  docs: 'setup',
  gaps: 'projects',
  home: 'home',
  integrations: 'clusters',
  layout: 'layout',
  notifications: 'settings',
  project: 'projects',
  reports: 'analytics',
  run: 'runs',
  settings: 'settings',
  'test-case': 'executions',
};

/** Components whose area is not their directory's: those that render on another area's pages. */
export const COMPONENT_AREAS: Readonly<Record<string, GuideAreaId>> = {
  'components/desktop/DesktopProjectFolderSection.vue': 'projects',
  'components/integrations/JiraConnectionForm.vue': 'settings',
  'components/integrations/ProjectIntegrationSettings.vue': 'projects',
  'components/layout/CompanionToolsCard.vue': 'setup',
  'components/layout/GetStartedWizard.vue': 'home',
  'components/project/ProjectTrendTable.vue': 'home',
  'components/test-case/FlakeLabDesktopButton.vue': 'test-cases',
  'components/test-case/FlakinessTab.vue': 'test-cases',
  'components/test-case/PathVariationCard.vue': 'test-cases',
  'components/test-case/TestCaseHistoryChart.vue': 'test-cases',
  'components/test-case/TestCaseMergeButton.vue': 'test-cases',
  'components/test-case/TestCaseStabilityTrend.vue': 'test-cases',
};

/** Help topics set in files of several areas whose blocks belong to one of them. */
export const TOPIC_AREAS: Readonly<Record<string, GuideAreaId>> = {
  'bug-report.spec': 'setup',
  'fix.toolbox': 'clusters',
  'run.keep': 'runs',
  'run.partial': 'runs',
};

/** The first of `areas` in the registry's order. */
function firstArea(areas: Iterable<GuideAreaId>): GuideAreaId | undefined {
  const named = new Set(areas);
  return AREA_IDS.find((area) => named.has(area));
}

/**
 * The area of a file of the app: a page's by its pattern, a component's by
 * `COMPONENT_AREAS`, else by its directory, else (`shared/`) the first area of
 * the pages it renders on; `undefined` when none applies.
 */
export function fileArea(path: string): GuideAreaId | undefined {
  if (path.startsWith('pages/')) return pageArea(pageOfFile(path));
  if (path === 'app.vue' || path.startsWith('layouts/')) return 'layout';
  if (COMPONENT_AREAS[path]) return COMPONENT_AREAS[path];
  const dir = /^components\/([\w-]+)\//.exec(path)?.[1];
  if (dir && COMPONENT_DIR_AREAS[dir]) return COMPONENT_DIR_AREAS[dir];
  return firstArea((PAGES_OF_FILE.get(path) ?? []).map(pageArea));
}

// ── The coverage items ─────────────────────────────────────────────────────

export interface CoverageItem {
  rule: GuideCoverageRule;
  /** How the rule names it, and how an exemption names it. */
  key: string;
  /** The area that covers it; `undefined` when no area rule applies, which the coverage test reports. */
  area: GuideAreaId | undefined;
  /** Where it is set, as paths from `app/`. */
  files: readonly string[];
  /** The page patterns it renders on. */
  pages: readonly string[];
  /** Whether `anchor` covers it. */
  covers: (anchor: GuideAnchor) => boolean;
}

/** Rule `page`: one anchor of kind `page` per page pattern, listing it. */
function pageItems(): CoverageItem[] {
  return [...PAGE_FILES].map(([page, files]) => ({
    rule: 'page',
    key: page,
    area: pageArea(page),
    files,
    pages: [page],
    covers: (anchor) => anchor.kind === 'page' && anchor.pages.includes(page),
  }));
}

/**
 * A list of the values of a tab's query, as the code declares it: in `file`,
 * the first array (or with `keys`, object) literal after `marker`.
 */
export interface TabList {
  page: string;
  file: string;
  marker: string;
  /** `strings`: each string of the array; `values`: each `value: '…'` of its items; `keys`: the object's keys. */
  pick: 'strings' | 'values' | 'keys';
  /** The query that selects the tab of `value`. */
  query: (value: string) => Record<string, string>;
}

/**
 * Every tab list of the dashboard that the URL selects. Tabs that live only in
 * a component's state (the MCP page's clients, the Screen tab's views, the
 * network and source cards' modes) have no URL to reveal them through, so their
 * blocks are anchored as blocks.
 */
export const TAB_LISTS: readonly TabList[] = [
  {
    page: '/projects/[id]',
    file: 'pages/projects/[id]/index.vue',
    marker: 'const TABS =',
    pick: 'strings',
    query: (tab) => ({ tab }),
  },
  // The Failures tab's segments, each selected by the alias that opens it.
  {
    page: '/projects/[id]',
    file: 'pages/projects/[id]/index.vue',
    marker: 'const ALIAS_SEGMENT: Record<string, FailureSegment> =',
    pick: 'keys',
    query: (tab) => ({ tab }),
  },
  {
    page: '/projects/[id]',
    file: 'components/project/ProjectSettingsPanel.vue',
    marker: 'const SECTION_IDS =',
    pick: 'strings',
    query: (section) => ({ tab: 'settings', section }),
  },
  {
    page: '/test-runs/[id]',
    file: 'pages/test-runs/[id].vue',
    marker: 'const tabItems = computed(() =>',
    pick: 'values',
    query: (tab) => ({ tab }),
  },
  {
    page: '/test-run-cases/[id]',
    file: 'components/test-case/EvidenceTabs.vue',
    marker: 'const tabs = computed<TabDef[]>(() =>',
    pick: 'values',
    query: (evidence) => ({ evidence }),
  },
  {
    page: '/test-cases/[id]',
    file: 'pages/test-cases/[id].vue',
    marker: 'const TABS =',
    pick: 'values',
    query: (tab) => ({ tab }),
  },
  {
    page: '/bug-reports/[id]',
    file: 'pages/bug-reports/[id].vue',
    marker: 'const TABS =',
    pick: 'strings',
    query: (tab) => ({ tab }),
  },
];

/** The bracketed literal opening with `open` at or after `from` in `source`, brackets included; '' when none. */
function bracketed(source: string, from: number, open: '[' | '{'): string {
  const close = open === '[' ? ']' : '}';
  const start = source.indexOf(open, from);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth++;
    if (source[i] === close && --depth === 0) return source.slice(start, i + 1);
  }
  return '';
}

/** The values a tab list declares; empty when its marker is not in the file. */
export function tabValues(list: TabList): string[] {
  const source = appSource(list.file);
  const at = source.indexOf(list.marker);
  if (at < 0) return [];
  const literal = bracketed(source, at + list.marker.length, list.pick === 'keys' ? '{' : '[');
  const pattern = {
    strings: /'([^']+)'/g,
    values: /\bvalue: '([^']+)'/g,
    keys: /^\s*'?([\w-]+)'?\s*:/gm,
  }[list.pick];
  return [...new Set([...literal.matchAll(pattern)].map((match) => match[1]!))];
}

/** Whether two queries name the same values. */
function sameQuery(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Rule `tab`: one anchor of kind `tab` per tab, on its page, whose `query` reveal selects exactly it. */
function tabItems(): CoverageItem[] {
  return TAB_LISTS.flatMap((list) =>
    tabValues(list).map((value): CoverageItem => {
      const query = list.query(value);
      return {
        rule: 'tab',
        key: `${list.page}?${new URLSearchParams(query)}`,
        area: pageArea(list.page),
        files: [list.file],
        pages: [list.page],
        covers: (anchor) =>
          anchor.kind === 'tab' && anchor.pages.includes(list.page) && sameQuery(revealQuery(anchor), query),
      };
    }),
  );
}

/**
 * Each help topic a `.vue` file sets statically, with the files that set it:
 * `help="…"` and `topic="…"` (`HelpHint`), the topics a bound `:help` or
 * `:topic` names as literals, and `help: '…'` in the script (prop defaults,
 * the configs a template binds). A `help` that is not a topic, such as a form
 * field's help text, is not one.
 */
export function staticHelpTopics(): Map<string, string[]> {
  const topics = new Map<string, string[]>();
  const add = (key: string, path: string) => {
    if (!(key in HELP_TOPICS)) return;
    const files = topics.get(key) ?? [];
    if (!files.includes(path)) topics.set(key, [...files, path]);
  };
  for (const { path, source } of vueFiles) {
    for (const [, , value] of source.matchAll(/(?<![\w:.-])([\w-]*(?:help|topic|Help|Topic))="([^"]*)"/g)) {
      add(value!, path);
    }
    for (const [, , expression] of source.matchAll(
      /(?<![\w-])(?::|v-bind:)([\w-]*(?:help|topic|Help|Topic))="([^"]*)"/g,
    )) {
      for (const [, literal] of expression!.matchAll(/'([^']+)'/g)) add(literal!, path);
    }
    for (const [, literal] of source.matchAll(/\b(?:help|topic|\w+Help|\w+Topic)\s*:\s*'([^']+)'/g)) {
      add(literal!, path);
    }
  }
  return topics;
}

/** The area of an item set in `files`: `TOPIC_AREAS` for a help topic, else the first of its files' areas. */
function itemArea(files: readonly string[], topic?: string): GuideAreaId | undefined {
  if (topic && TOPIC_AREAS[topic]) return TOPIC_AREAS[topic];
  const areas = files.map(fileArea);
  return areas.includes(undefined) ? undefined : firstArea(areas as GuideAreaId[]);
}

/** The pages `files` render on, in order. */
function pagesOf(files: readonly string[]): string[] {
  return [...new Set(files.flatMap((path) => PAGES_OF_FILE.get(path) ?? []))];
}

/** Rule `help`: every help topic set statically is the `help` of some anchor. */
function helpItems(): CoverageItem[] {
  return [...staticHelpTopics()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([topic, files]) => ({
      rule: 'help',
      key: topic,
      area: itemArea(files, topic),
      files,
      pages: pagesOf(files),
      covers: (anchor) => anchor.help === topic,
    }));
}

/** Rule `field`: one anchor of kind `field` per field of `SETTINGS_PAGES`, on its page, whose `help` is the field's. */
function fieldItems(): CoverageItem[] {
  const topics = staticHelpTopics();
  return SETTINGS_PAGES.flatMap((page) =>
    page.fields.map((field): CoverageItem => {
      const onPage = (topics.get(field.help) ?? []).filter((path) => PAGES_OF_FILE.get(path)?.includes(page.to));
      return {
        rule: 'field',
        key: field.id,
        area: pageArea(page.to),
        files: onPage.length > 0 ? onPage : (PAGE_FILES.get(page.to) ?? []),
        pages: [page.to],
        covers: (anchor) => anchor.kind === 'field' && anchor.pages.includes(page.to) && anchor.help === field.help,
      };
    }),
  );
}

export const LAYOUT_FILE = 'layouts/default.vue';

/**
 * Each destination of the sidebar, as the layout builds it (the command
 * palette's Go to group lists the same items): its `to`, with a template's
 * `${…}` as `[id]`, and the `'data-tour'` value its item carries.
 */
export function sidebarDestinations(): { to: string; dataTour: string | undefined }[] {
  const source = appSource(LAYOUT_FILE);
  const start = source.indexOf('const projectItems = computed');
  const end = source.indexOf('const toCommandPaletteItem');
  if (start < 0 || end < start) return [];
  return source
    .slice(start, end)
    .split(/\blabel:/)
    .slice(1)
    .flatMap((item) => {
      const to = /\bto:\s*(?:'([^']*)'|`([^`]*)`|([A-Za-z_][\w.]*))/.exec(item);
      if (!to) return [];
      return [
        {
          to: to[1] ?? to[2]?.replace(/\$\{[^}]*\}/g, '[id]') ?? to[3]!,
          dataTour: /'data-tour':\s*'([^']*)'/.exec(item)?.[1],
        },
      ];
    });
}

/** Rule `nav`: every sidebar destination carries the `data-tour` of an anchor of kind `nav`. */
function navItems(): CoverageItem[] {
  return sidebarDestinations().map(({ to, dataTour }) => ({
    rule: 'nav',
    key: to,
    area: 'layout',
    files: [LAYOUT_FILE],
    pages: ['*'],
    covers: (anchor) => anchor.kind === 'nav' && anchor.id === dataTour,
  }));
}

/** Every item the coverage rules ask an anchor for, rule by rule. */
export function coverageItems(): CoverageItem[] {
  return [...pageItems(), ...tabItems(), ...fieldItems(), ...helpItems(), ...navItems()];
}

/** How a coverage report names an item: its key, where it is set and the pages it renders on. */
export function describeItem(item: CoverageItem): string {
  const pages = item.pages.length > 0 ? `; on ${item.pages.join(', ')}` : '';
  return `${item.key} (${item.files.join(', ')}${pages})`;
}
