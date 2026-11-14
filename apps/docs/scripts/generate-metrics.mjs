/**
 * Generates apps/docs/reference/metrics.md — the Metrics page — from the metric
 * catalog (apps/application/shared/analytics/metrics.ts).
 *
 * The page is a build artifact (gitignored): `docs:dev` and `docs:build` run
 * this first, so a definition here is the one the widgets, quality reports, MCP
 * tools and exports print. To change a metric's entry, edit the catalog.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const jiti = createJiti(import.meta.url);

const { METRICS } = await jiti.import(join(repoRoot, 'application/shared/analytics/metrics.ts'));

/** One section per grain, the thing a metric counts, in this order; `anchor` is a section's id where it is not its title's slug. */
const GRAINS = [
  { id: 'run', title: 'Runs', intro: 'Counted over the runs of the period.' },
  { id: 'test', title: 'Tests', intro: 'Counted over the tests and executions of the period.' },
  {
    id: 'cluster',
    title: 'Failure clusters',
    anchor: 'failure-causes',
    intro: 'Counted over [failure clusters](/guide/concepts#error-fingerprint-failure-cluster), which outlive run retention.',
  },
  {
    id: 'gap',
    title: 'Scenario gaps',
    intro: 'Counted over the [Test Map](/features/scenario-gaps); hidden where the Test Map is declined.',
  },
  {
    id: 'handback',
    title: 'Hand-back outcomes',
    intro:
      'Counted over what became of what Piwi handed back ([Hand-back outcomes](/features/analytics#hand-back-outcomes)), per project and day, so branch and environment filters do not narrow them. A rate is empty below 10 ratings, pull requests or fixes, and a metric is hidden where the capability it belongs to is declined.',
  },
];

const UNITS = {
  percent: 'percent',
  count: 'count',
  minutes: 'minutes',
  ms: 'milliseconds',
  days: 'days',
  money: 'currency',
};

const BETTER = { higher: 'higher', lower: 'lower', neutral: 'neither' };

const HISTORY = {
  rollup: 'any period',
  live: 'stored rows',
};

// The docs write no em dash; the catalog text may use them for asides.
const cell = (text) =>
  text
    .replace(/\s+—\s+/g, ', ')
    .replace(/—/g, ', ')
    .replace(/\|/g, '\\|');

const metricRow = (metric) =>
  `| <span id="${metric.id}">**${cell(metric.label)}**</span> \`${metric.id}\` | ${UNITS[metric.unit] ?? metric.unit} | ${BETTER[metric.betterWhen]} | ${HISTORY[metric.source]} | ${cell(metric.definition)} |`;

function grainSection(grain) {
  const metrics = METRICS.filter((metric) => metric.grain === grain.id);
  if (metrics.length === 0) return '';
  return [
    grain.anchor ? `## ${grain.title} {#${grain.anchor}}` : `## ${grain.title}`,
    '',
    grain.intro,
    '',
    '| Metric | Unit | Better when | History | Definition |',
    '|--------|------|-------------|---------|------------|',
    ...metrics.map(metricRow),
    '',
  ].join('\n');
}

const known = new Set(GRAINS.map((grain) => grain.id));
const orphans = METRICS.filter((metric) => !known.has(metric.grain)).map((metric) => metric.id);
if (orphans.length > 0) throw new Error(`Metrics of an unknown grain: ${orphans.join(', ')}`);

const page = `---
title: Metrics
description: Every number the analytics widgets, quality reports, MCP tools and exports show, with its unit, which direction is better and its definition, generated from the metric catalog.
lang: en-US
editLink: false
---

<!-- GENERATED FILE, do not edit. -->
<!-- Source of truth: apps/application/shared/analytics/metrics.ts, rendered by apps/docs/scripts/generate-metrics.mjs (npm run docs:gen). -->

# Metrics

The metric catalog: every number the [analytics widgets](/reference/analytics-widgets), the
[quality reports](/features/quality-reports), the [MCP tools](/reference/mcp-tools#get_metric_trend) and the
[metrics export](/operate/metrics) show, so a number means the same thing wherever it appears. Days are UTC.

**History** says how far back a metric reaches. *Any period*: it is read from the daily rollups, which keep their
numbers when [retention](/operate/storage#data-retention) deletes old runs. *Stored rows*: it is read from the runs,
clusters or gaps still stored, so a metric about test identities reaches back only as far as retention keeps runs.

${GRAINS.map(grainSection).filter(Boolean).join('\n')}
## Related

- [Analytics](/features/analytics): the scope and the comparison period every metric is measured over
- [Analytics widgets](/reference/analytics-widgets): the widgets that show these metrics
- [Metrics and rollup export](/operate/metrics): the rollups behind the *any period* metrics
`;

mkdirSync(join(here, '..', 'reference'), { recursive: true });
writeFileSync(join(here, '..', 'reference', 'metrics.md'), page);
console.log(`generated apps/docs/reference/metrics.md from ${METRICS.length} metrics`);
