/**
 * Generates apps/docs/reference/analytics-widgets.md — the Analytics widgets
 * page — from the widget registry (apps/application/shared/analytics/registry.ts).
 *
 * The page is a build artifact (gitignored): `docs:dev` and `docs:build` run
 * this first, so the list can never drift from the widgets the dashboard
 * offers. To change a widget's entry, edit the registry. The band headings are
 * deep-linked from the in-app help, so a band's label is its anchor.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
// The registry imports zod. The docs build installs only apps/docs, so zod
// resolves from here rather than from the application's node_modules.
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { alias: { zod: dirname(require.resolve('zod/package.json')) } });

const { ANALYTICS_BANDS, ANALYTICS_WIDGETS } = await jiti.import(
  join(repoRoot, 'application/shared/analytics/registry.ts'),
);
const { OVERVIEW_DASHBOARD } = await jiti.import(join(repoRoot, 'application/shared/analytics/dashboards.ts'));

const onOverview = new Set(OVERVIEW_DASHBOARD.bands.flatMap((band) => band.widgets.map((widget) => widget.type)));

// The docs write no em dash; the registry text may use them for asides.
const cell = (text) =>
  text
    .replace(/\s+—\s+/g, ', ')
    .replace(/—/g, ', ')
    .replace(/\|/g, '\\|');

function notes(widget) {
  const list = [];
  if (onOverview.has(widget.id)) list.push('on the Analytics page');
  if (widget.requires === 'single-project') list.push('one project in scope');
  if (widget.capability === 'test-map') list.push('hidden where the [Test Map](/features/scenario-gaps) is declined');
  if (widget.capability === 'coverage') list.push('hidden where [coverage](/features/combined-coverage) is declined');
  return list.length > 0 ? list.join('; ') : '';
}

const widgetRow = (widget) =>
  `| **${cell(widget.title)}** \`${widget.id}\` | ${cell(widget.description)} | ${widget.testFilters ? 'yes' : 'no'} | ${notes(widget)} |`;

function bandSection(band) {
  const widgets = ANALYTICS_WIDGETS.filter((widget) => widget.band === band.id);
  return [
    `## ${band.label}`,
    '',
    band.description,
    '',
    '| Widget | What it shows | Follows a test filter | Notes |',
    '|--------|---------------|-----------------------|-------|',
    ...widgets.map(widgetRow),
    '',
  ].join('\n');
}

const bandIds = new Set(ANALYTICS_BANDS.map((band) => band.id));
const orphans = ANALYTICS_WIDGETS.filter((widget) => !bandIds.has(widget.band)).map((widget) => widget.id);
if (orphans.length > 0) throw new Error(`Analytics widgets in no known band: ${orphans.join(', ')}`);

const page = `---
title: Analytics widgets
description: Every widget of the Analytics page and of analytics dashboards, band by band, with what it shows and whether it follows a test filter, generated from the widget registry.
lang: en-US
editLink: false
---

<!-- GENERATED FILE, do not edit. -->
<!-- Source of truth: apps/application/shared/analytics/registry.ts, rendered by apps/docs/scripts/generate-analytics-widgets.mjs (npm run docs:gen). -->

# Analytics widgets

Every widget the [Analytics](/features/analytics) page shows and an [analytics dashboard](/features/dashboards) can
place, listed under its home band: the band of the Analytics page it belongs to, and the group the widget picker lists
it under. Each widget follows the scope bar. One that does not follow a **test filter** (a selection, test tags or
browsers) says so under its title when a test filter is set. The numbers the widgets show are defined once, in
[Metrics](/reference/metrics).

${ANALYTICS_BANDS.map(bandSection).join('\n')}
## Related

- [Analytics](/features/analytics): the scope, periods, targets and chart export
- [Dashboards](/features/dashboards): arranging these widgets into analytics dashboards of your own
- [Quality reports](/features/quality-reports): any analytics dashboard as a document
- [Metrics](/reference/metrics): what each number counts
`;

mkdirSync(join(here, '..', 'reference'), { recursive: true });
writeFileSync(join(here, '..', 'reference', 'analytics-widgets.md'), page);
console.log(`generated apps/docs/reference/analytics-widgets.md from ${ANALYTICS_WIDGETS.length} widgets`);
