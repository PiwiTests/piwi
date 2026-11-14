/**
 * The site's top navigation, sidebars and landing cards. Plain data with no
 * VitePress import, so `apps/application/tests/unit/docs-drift.test.ts` can load
 * it and check every entry against its page.
 *
 * The Features sidebar, the Tools sidebar and the landing cards are not written
 * here: they are rendered from the feature catalog
 * (`apps/application/shared/piwi-features.ts`), one sidebar group per catalog
 * group, so the sidebars, the landing page and the All features page always show
 * the same groups in the same order. Recipes are not features, so
 * `RECIPES_BY_GROUP` puts each one at the top of the catalog group it serves.
 */
import { PIWI_FEATURE_GROUPS, TOOLS_SECTION } from '../../application/shared/piwi-features';

export interface SidebarItem {
  text: string;
  /** Absent on a label: a heading over the entries nested under it. */
  link?: string;
  /** The entries nested under this one, indented below it. */
  items?: SidebarItem[];
  /** On a label: `false` shows its entries and lets the reader fold them. */
  collapsed?: boolean;
}

export interface SidebarGroup {
  text: string;
  /** The group's own page: its heading is then a link to it. */
  link?: string;
  items: SidebarItem[];
  collapsed?: boolean;
}

/** A sidebar entry that leads somewhere: a page of the site, or another site. */
export interface SidebarLink {
  text: string;
  link: string;
}

export interface NavItem {
  text: string;
  link: string;
  activeMatch?: string;
}

export interface LandingCard {
  title: string;
  details: string;
  link: string;
  linkText: string;
}

/** Each recipe, keyed by the title of the catalog group it opens. */
export const RECIPES_BY_GROUP: Record<string, SidebarItem[]> = {
  'Explain the failures': [
    { text: 'Regression or flake?', link: '/recipes/regression-or-flaky' },
    { text: 'Triage a run gone red', link: '/recipes/mass-failure' },
    { text: 'Cut costly flakiness', link: '/recipes/flaky-cleanup' },
  ],
  'Time and resources': [{ text: 'Cut the time it costs', link: '/recipes/faster-suite' }],
  'Hand back a fix': [{ text: 'Fix a broken locator', link: '/recipes/broken-locator' }],
};

/**
 * The anchor VitePress gives a heading: the heading's text, where a link counts
 * as its label and inline HTML such as a badge not at all, passed through the
 * `slugify` of `@mdit-vue/shared` that the docs build uses. It is copied rather
 * than imported because the app's unit tests load this module without the docs
 * dependencies installed.
 */
export function headingAnchor(heading: string): string {
  return heading
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase();
}

/**
 * Every link of a sidebar in reading order: a group's own page, then its
 * entries, each before the ones nested under it. A label has no link and is
 * left out.
 */
export function sidebarEntries(groups: SidebarGroup[]): SidebarLink[] {
  const linked = ({ text, link }: SidebarItem | SidebarGroup): SidebarLink[] => (link ? [{ text, link }] : []);
  const withNested = (items: SidebarItem[]): SidebarLink[] =>
    items.flatMap((item) => [...linked(item), ...withNested(item.items ?? [])]);
  return groups.flatMap((group) => [...linked(group), ...withNested(group.items)]);
}

/**
 * One sidebar group per catalog group of the Features section, holding its
 * recipes and then the catalog entries whose page lives under /features/.
 * Several entries can point into the same page with different anchors; each
 * keeps its own item, and a whole-page entry appears once. The groups are
 * collapsed: VitePress opens the one that holds the current page.
 */
export function featuresSidebar(): SidebarGroup[] {
  return PIWI_FEATURE_GROUPS.filter((group) => group.section !== 'tools').map((group) => {
    const pages = new Set<string>();
    const features: SidebarItem[] = [];
    for (const feature of group.features) {
      if (!feature.doc.startsWith('features/')) continue;
      if (!feature.doc.includes('#')) {
        if (pages.has(feature.doc)) continue;
        pages.add(feature.doc);
      }
      features.push({ text: feature.title, link: `/${feature.doc}` });
    }
    return {
      text: group.title,
      collapsed: true,
      items: [...(RECIPES_BY_GROUP[group.title] ?? []), ...features],
    };
  }).filter((group) => group.items.length > 0);
}

/**
 * One sidebar group per tool of the catalog. A group whose first entry carries
 * its title has that entry's page as its own: the heading links to it. The
 * entries that follow are links, and consecutive entries that share a `part`
 * sit under that part's label, which folds them.
 */
export function toolsSidebar(): SidebarGroup[] {
  return PIWI_FEATURE_GROUPS.filter((group) => group.section === 'tools').map((group) => {
    const own = group.features[0]?.title === group.title ? group.features[0] : undefined;
    const items: SidebarItem[] = [];
    for (const feature of own ? group.features.slice(1) : group.features) {
      const entry = { text: feature.title, link: `/${feature.doc}` };
      const last = items.at(-1);
      if (!feature.part) items.push(entry);
      else if (last?.items && !last.link && last.text === feature.part) last.items.push(entry);
      else items.push({ text: feature.part, collapsed: false, items: [entry] });
    }
    return { text: group.title, ...(own ? { link: `/${own.doc}` } : {}), collapsed: true, items };
  });
}

/** The pages of the Tools sidebar, as site paths: `/features/editors`. */
export function toolPages(): string[] {
  return sidebarEntries(toolsSidebar()).map((entry) => entry.link);
}

/**
 * The landing page's cards, in catalog order: one per group that takes a card,
 * linking to that group on the All features page with the count of its
 * features, and one for the Tools section, linking to its first page with the
 * count of every tool's features.
 */
export function landingCards(): LandingCard[] {
  const tools = PIWI_FEATURE_GROUPS.filter((group) => group.section === 'tools');
  return PIWI_FEATURE_GROUPS.flatMap((group): LandingCard[] => {
    if (group.section === 'tools') {
      if (group !== tools[0]) return [];
      const features = tools.reduce((count, tool) => count + tool.features.length, 0);
      return [
        { title: TOOLS_SECTION.title, details: TOOLS_SECTION.intro, link: toolPages()[0]!, linkText: `${features} features` },
      ];
    }
    if (group.card === false) return [];
    return [
      {
        title: group.title,
        details: group.intro,
        link: `/reference/features#${headingAnchor(group.title)}`,
        linkText: `${group.features.length} features`,
      },
    ];
  });
}

export const guideSidebar: SidebarGroup[] = [
  {
    text: 'Get started',
    items: [
      { text: 'Getting started', link: '/guide/getting-started' },
      { text: 'Your first failure, explained', link: '/guide/first-failure' },
      { text: 'Core concepts', link: '/guide/concepts' },
    ],
  },
  {
    text: 'Set up',
    items: [
      { text: 'Reporter', link: '/guide/reporter' },
      { text: 'Capture fixtures', link: '/guide/capture-fixtures' },
      { text: 'CI & sharding', link: '/guide/ci' },
      { text: 'Source control', link: '/guide/source-control' },
      {
        text: 'AI provider',
        link: '/guide/ai-provider',
        items: [
          { text: 'Codex CLI', link: '/guide/codex-cli' },
          { text: 'DeepSeek CLI', link: '/guide/deepseek-cli' },
        ],
      },
      { text: 'Backend instrumentation', link: '/guide/backend-logs' },
      { text: 'Import past runs', link: '/guide/importing-runs' },
    ],
  },
  {
    text: 'About Piwi',
    items: [
      { text: 'What Piwi does', link: '/guide/what-piwi-does' },
      { text: 'Why Piwi?', link: '/guide/comparison' },
      { text: 'Privacy & data flow', link: '/guide/privacy' },
      { text: 'License', link: '/guide/license' },
    ],
  },
];

export const selfHostingSidebar: SidebarGroup[] = [
  {
    text: 'Install',
    items: [
      { text: 'Deployment', link: '/operate/deployment' },
      { text: 'One-click deploy', link: '/operate/one-click-deploy' },
      { text: 'Production checklist', link: '/operate/production-checklist' },
    ],
  },
  {
    text: 'Configure',
    items: [
      { text: 'Authentication', link: '/operate/authentication' },
      { text: 'Access, roles and groups', link: '/operate/project-access' },
      { text: 'API keys', link: '/operate/api-keys' },
      { text: 'Localization', link: '/operate/localization' },
      { text: 'Choose what you use', link: '/operate/capabilities' },
      { text: 'Integrations', link: '/operate/integrations' },
      { text: 'Zephyr Scale Cloud', link: '/operate/zephyr-scale' },
      { text: 'Configuration reference', link: '/reference/configuration' },
      { text: 'Configuration generator', link: '/reference/configuration/generator' },
    ],
  },
  {
    text: 'Data',
    items: [
      { text: 'Database', link: '/operate/database' },
      { text: 'Storage & retention', link: '/operate/storage' },
      { text: 'Backup & restore', link: '/operate/backup-restore' },
      { text: 'Metrics and rollup export', link: '/operate/metrics' },
      { text: 'Tracing with OpenTelemetry', link: '/operate/tracing' },
    ],
  },
  {
    text: 'Upgrade',
    items: [{ text: 'Upgrading', link: '/operate/upgrading' }],
  },
];

export const referenceSidebar: SidebarGroup[] = [
  {
    text: 'Product',
    items: [
      { text: 'All features', link: '/reference/features' },
      { text: "What's new", link: '/reference/whats-new' },
    ],
  },
  {
    text: 'Configuration',
    items: [
      { text: 'Configuration reference', link: '/reference/configuration' },
      { text: 'Configuration generator', link: '/reference/configuration/generator' },
      { text: 'Reporter options', link: '/reference/reporter-options' },
      { text: 'Coverage cost', link: '/reference/coverage-cost' },
    ],
  },
  {
    text: 'Reporter & CLI',
    items: [
      { text: 'Piwi CLI', link: '/reference/cli' },
      { text: 'Test metadata', link: '/reference/test-metadata' },
      { text: 'Steps file format', link: '/reference/steps-format' },
      { text: 'Bug report file format', link: '/reference/bug-report-file' },
    ],
  },
  {
    text: 'Analysis rules',
    items: [
      { text: 'Clue rules', link: '/reference/clues' },
      { text: 'Locator stability rules', link: '/reference/locator-stability' },
      { text: 'Gap detectors & exposure', link: '/reference/gap-detectors' },
    ],
  },
  {
    text: 'Dashboard',
    items: [
      { text: 'Test search', link: '/reference/test-search' },
      { text: 'Keyboard shortcuts', link: '/reference/keyboard-shortcuts' },
      { text: 'Analytics widgets', link: '/reference/analytics-widgets' },
      { text: 'Metrics', link: '/reference/metrics' },
    ],
  },
  {
    text: 'Automation',
    items: [
      { text: 'MCP tools', link: '/reference/mcp-tools' },
      { text: 'Notification events & webhooks', link: '/reference/notification-events' },
      { text: 'API docs (interactive)', link: 'https://piwitests.dev/demo/settings/api' },
    ],
  },
];

/**
 * A tool's page keeps its place under /features/ or /guide/, so the Guide and
 * Features items leave the Tools pages out of their match and the Tools item
 * matches exactly those. VitePress tests the pattern against the page's path
 * without its extension.
 */
const toolRoutes = toolPages()
  .map((page) => page.slice(1))
  .join('|');

export const nav: NavItem[] = [
  { text: 'Guide', link: '/guide/getting-started', activeMatch: `^/(?!(${toolRoutes})$)guide/` },
  { text: 'Features', link: '/features/ui-overview', activeMatch: `^/(?!(${toolRoutes})$)(features|recipes)/` },
  { text: 'Tools', link: toolPages()[0]!, activeMatch: `^/(${toolRoutes})$` },
  { text: 'Self-hosting', link: '/operate/deployment', activeMatch: '/operate/' },
  { text: 'Reference', link: '/reference/features', activeMatch: '/reference/' },
  { text: 'Blog', link: '/blog/' },
  { text: 'Demo', link: 'https://piwitests.dev/demo/' },
];

/**
 * Sidebars keyed by URL path prefix. VitePress takes the first key the page's
 * path starts with, the keys with the most path segments first and, among
 * equals, in the order written here. A tool's page keeps its place under
 * /features/ or /guide/, so each one is a key of its own, written before the
 * section it lives in. Recipes live under /recipes/ but sit in the Features
 * groups, so both prefixes show the same sidebar. The landing page shows none.
 */
export function sidebars(): Record<string, SidebarGroup[]> {
  const features = featuresSidebar();
  const tools = toolsSidebar();
  return {
    ...Object.fromEntries(toolPages().map((page) => [page, tools])),
    '/guide/': guideSidebar,
    '/features/': features,
    '/recipes/': features,
    '/operate/': selfHostingSidebar,
    '/reference/': referenceSidebar,
  };
}
