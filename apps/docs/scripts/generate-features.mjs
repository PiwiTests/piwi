/**
 * Generates apps/docs/reference/features.md — the All features page — from the
 * feature catalog (apps/application/shared/piwi-features.ts), followed by the
 * pieces and setup decisions (apps/application/shared/piwi-ecosystem.ts).
 *
 * The page is a build artifact (gitignored): `docs:dev` and `docs:build` run
 * this first, so the page can never drift from the catalog. To change the page,
 * edit the catalog. Every `doc` target in the catalog is resolved against a
 * real page + heading by apps/application/tests/unit/docs-drift.test.ts.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const jiti = createJiti(import.meta.url);

const { PIWI_FEATURE_GROUPS, FEATURE_NEED_LABELS } = await jiti.import(
  join(repoRoot, 'application/shared/piwi-features.ts'),
);
// The pieces and the setup decisions — the same registry the MCP describe_piwi
// tool answers from, so the tool never says anything this page does not.
const { ECOSYSTEM_PIECES, SETUP_DECISIONS } = await jiti.import(
  join(repoRoot, 'application/shared/piwi-ecosystem.ts'),
);

const cell = (text) => text.replace(/\|/g, '\\|');

/** Extra prerequisites, or "reporter" when a feature needs nothing more. */
const needs = (list) => (list.length === 0 ? 'reporter' : list.map((n) => FEATURE_NEED_LABELS[n]).join(', '));

const featureRow = ({ title, summary, needs: need, where, doc }) =>
  `| [${cell(title)}](/${doc}) | ${cell(summary)} | ${cell(needs(need))} | ${cell(where)} |`;

function groupMarkdown({ title, intro, features }) {
  return [
    `## ${title}`,
    '',
    intro,
    '',
    '| Feature | What it does | Needs | Where |',
    '|---------|--------------|-------|-------|',
    ...features.map(featureRow),
    '',
  ].join('\n');
}

const total = PIWI_FEATURE_GROUPS.reduce((n, g) => n + g.features.length, 0);

const pieceRow = ({ name, summary, get, when, doc }) =>
  `| [${cell(name)}](/${doc}) | ${cell(summary)} | ${cell(get)} | ${cell(when)} |`;

const piecesMarkdown = [
  '## The pieces',
  '',
  'What you install or reach, how to get each piece, and when you need it.',
  '',
  '| Piece | What it is | How to get it | When you need it |',
  '|-------|------------|---------------|------------------|',
  ...ECOSYSTEM_PIECES.map(pieceRow),
  '',
].join('\n');

const decisionMarkdown = ({ question, default: fallback, options, doc }) =>
  [
    `### ${question}`,
    '',
    `*Default:* ${fallback} [Details](/${doc})`,
    '',
    ...options.map(({ option, when }) => `- **${option}** — ${when}`),
    '',
  ].join('\n');

const decisionsMarkdown = [
  '## Choosing a setup',
  '',
  'The decisions a team makes once, what happens if you make none, and the page that settles each.',
  '',
  ...SETUP_DECISIONS.map(decisionMarkdown),
].join('\n');

const page = `---
title: All features
description: Every Piwi feature in one table per group, with what it needs beyond the reporter, where it lives in the dashboard, and the page that explains it.
lang: en-US
editLink: false
---

<!-- GENERATED FILE — do not edit. -->
<!-- Source of truth: apps/application/shared/piwi-features.ts and piwi-ecosystem.ts, rendered by apps/docs/scripts/generate-features.mjs (npm run docs:gen). -->

# All features

Everything Piwi does, in one place: what each feature is, what it needs beyond
a running [reporter](/guide/reporter), where it lives in the dashboard, and the
page that explains it. The groups are the four jobs the product serves (**keep
the history**, **explain the failures**, **hand back a fix**, **find what your
tests miss**), each with the narrower groups that follow from it, then trends
and reports, the tools you install, and what an operator runs. The docs sidebars
and the landing page use the same groups.

New here? Start with [What Piwi does](/guide/what-piwi-does) and [Getting started](/guide/getting-started); this page is the "where next" once a first run has landed. The last two sections list the pieces you install and the decisions a setup involves.

${PIWI_FEATURE_GROUPS.map(groupMarkdown).join('\n')}
${piecesMarkdown}
${decisionsMarkdown}`;

mkdirSync(join(here, '..', 'reference'), { recursive: true });
writeFileSync(join(here, '..', 'reference', 'features.md'), page);
console.log(
  `generated apps/docs/reference/features.md from ${total} features, ${ECOSYSTEM_PIECES.length} pieces and ${SETUP_DECISIONS.length} decisions`,
);
