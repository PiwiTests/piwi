/**
 * The site's top navigation, sidebars and landing cards. Plain data with no
 * VitePress import, so `apps/application/tests/unit/docs-drift.test.ts` can load
 * it and check every entry against its page.
 *
 * The Features sidebar and the landing cards are not written here: they are
 * rendered from the feature catalog (`apps/application/shared/piwi-features.ts`),
 * one sidebar group and one card per catalog group, so the sidebar, the landing
 * page and the All features page always show the same groups in the same order.
 * Recipes are not features, so `RECIPES_BY_GROUP` puts each one at the top of the
 * catalog group it serves.
 */
import { PIWI_FEATURE_GROUPS } from '../../application/shared/piwi-features';

export interface SidebarItem {
  text: string;
  link: string;
}

export interface SidebarGroup {
  text: string;
  items: SidebarItem[];
  collapsed?: boolean;
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
    { text: 'Cut the time it costs', link: '/recipes/faster-suite' },
  ],
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
 * One sidebar group per catalog group, holding its recipes and then the catalog
 * entries whose page lives under /features/. Several entries can point into the
 * same page with different anchors; each keeps its own item, and a whole-page
 * entry appears once.
 */
export function featuresSidebar(): SidebarGroup[] {
  return PIWI_FEATURE_GROUPS.map((group) => {
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
      collapsed: false,
      items: [...(RECIPES_BY_GROUP[group.title] ?? []), ...features],
    };
  }).filter((group) => group.items.length > 0);
}

/** One landing card per catalog group, linking to that group on the All features page. */
export function landingCards(): LandingCard[] {
  return PIWI_FEATURE_GROUPS.map((group) => ({
    title: group.title,
    details: group.intro,
    link: `/reference/features#${headingAnchor(group.title)}`,
    linkText: `${group.features.length} features`,
  }));
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
      { text: 'AI provider', link: '/guide/ai-provider' },
      { text: 'Codex CLI', link: '/guide/codex-cli' },
      { text: 'DeepSeek CLI', link: '/guide/deepseek-cli' },
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
    text: 'Reference',
    items: [
      { text: 'All features', link: '/reference/features' },
      { text: "What's new", link: '/reference/whats-new' },
      { text: 'Configuration reference', link: '/reference/configuration' },
      { text: 'Configuration generator', link: '/reference/configuration/generator' },
      { text: 'Reporter options', link: '/reference/reporter-options' },
      { text: 'Coverage cost', link: '/reference/coverage-cost' },
      { text: 'Test metadata', link: '/reference/test-metadata' },
      { text: 'Test search', link: '/reference/test-search' },
      { text: 'Clue rules', link: '/reference/clues' },
      { text: 'Locator stability rules', link: '/reference/locator-stability' },
      { text: 'Piwi CLI', link: '/reference/cli' },
      { text: 'Steps file format', link: '/reference/steps-format' },
      { text: 'Bug report file format', link: '/reference/bug-report-file' },
      { text: 'MCP tools', link: '/reference/mcp-tools' },
      { text: 'Analytics widgets', link: '/reference/analytics-widgets' },
      { text: 'Metrics', link: '/reference/metrics' },
      { text: 'Gap detectors & exposure', link: '/reference/gap-detectors' },
      { text: 'Notification events & webhooks', link: '/reference/notification-events' },
      { text: 'Keyboard shortcuts', link: '/reference/keyboard-shortcuts' },
      { text: 'API docs (interactive)', link: 'https://piwitests.dev/demo/docs' },
    ],
  },
];

export const nav: NavItem[] = [
  { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
  { text: 'Features', link: '/features/ui-overview', activeMatch: '/(features|recipes)/' },
  { text: 'Self-hosting', link: '/operate/deployment', activeMatch: '/operate/' },
  { text: 'Reference', link: '/reference/features', activeMatch: '/reference/' },
  { text: 'Blog', link: '/blog/' },
  { text: 'Demo', link: 'https://piwitests.dev/demo/' },
];

/**
 * Sidebars keyed by URL path prefix; VitePress picks the longest prefix that
 * matches the current page. Recipes live under /recipes/ but sit in the Features
 * groups, so both prefixes show the same sidebar. The landing page shows none.
 */
export function sidebars(): Record<string, SidebarGroup[]> {
  const features = featuresSidebar();
  return {
    '/guide/': guideSidebar,
    '/features/': features,
    '/recipes/': features,
    '/operate/': selfHostingSidebar,
    '/reference/': referenceSidebar,
  };
}
