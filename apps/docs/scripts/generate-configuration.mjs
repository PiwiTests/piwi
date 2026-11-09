/**
 * Generates apps/docs/configuration.md — the configuration reference page — from
 * the typed env-var registry (apps/application/shared/piwi-env-vars.ts), with
 * the Settings fields each variable overrides (shared/settings-metadata.ts).
 *
 * The page is a build artifact (gitignored): `docs:dev` and `docs:build` run
 * this first, so the reference and the interactive generator can never drift
 * from the registry. To change the page, edit the registry.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const jiti = createJiti(import.meta.url);

const registry = await jiti.import(join(repoRoot, 'application/shared/piwi-env-vars.ts'));
const { PIWI_ENV_VARS, PIWI_ENV_CATEGORIES } = registry;
const { SETTINGS_PAGES, fieldEnvVars } = await jiti.import(join(repoRoot, 'application/shared/settings-metadata.ts'));
const require = createRequire(import.meta.url);
const appVersion = require(join(repoRoot, 'application/package.json')).version;

const varNames = Object.keys(PIWI_ENV_VARS);
const varsOfCategory = (category) => varNames.filter((name) => PIWI_ENV_VARS[name].category === category);

/** Categories rendered as their own section, in display order. */
const sections = Object.entries(PIWI_ENV_CATEGORIES)
  .filter(([, meta]) => !meta.internal && !meta.mergeInto)
  .sort(([, a], [, b]) => a.order - b.order);

/** Categories folded into a parent section, keyed by parent. */
const mergedInto = new Map();
for (const [category, meta] of Object.entries(PIWI_ENV_CATEGORIES)) {
  if (!meta.mergeInto || meta.internal) continue;
  const list = mergedInto.get(meta.mergeInto) ?? [];
  list.push(category);
  mergedInto.set(meta.mergeInto, list);
}

/**
 * Renders bare URLs and email addresses from registry text as code spans.
 * VitePress linkifies bare URLs/emails, which turns placeholder values like
 * `https://piwi.example.com` into clickable dead links. Text already inside
 * backticks or a markdown link target (`](url)`) is left untouched.
 */
const codeifyBareLinks = (text) =>
  text
    .split('`')
    .map((segment, i) => {
      if (i % 2 === 1) return segment; // inside an existing code span
      return segment
        .replace(/(?<!\]\()(https?:\/\/[^\s|)]+)/g, '`$1`')
        .replace(/(?<![\w`.@/-])([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g, '`$1`');
    })
    .join('`');

/** The Settings pages with a field whose help names each variable, keyed by variable. */
const settingsPagesOf = new Map();
for (const page of SETTINGS_PAGES) {
  for (const field of page.fields) {
    if (field.envOnly) continue;
    for (const name of fieldEnvVars(field)) {
      const labels = settingsPagesOf.get(name) ?? [];
      if (!labels.includes(page.label)) labels.push(page.label);
      settingsPagesOf.set(name, labels);
    }
  }
}

/** A `relevantWhen` / `requiredWhen` condition in words: `'*'` is any value, `''` unset. */
const conditionText = (condition) =>
  Object.entries(condition)
    .map(([name, value]) =>
      value === '*' ? `\`${name}\` is set` : value === '' ? `\`${name}\` is unset` : `\`${name}\` is \`${value}\``,
    )
    .join(' and ');

/** The registry's metadata a reader needs besides the description: values, range, conditions, secrecy. */
function metaNotes(meta, name) {
  const notes = [];
  if (meta.enum?.length) notes.push(`Values: ${meta.enum.map((value) => `\`${value}\``).join(', ')}.`);
  if (meta.min !== undefined && meta.max !== undefined) notes.push(`Range: ${meta.min} to ${meta.max}.`);
  else if (meta.min !== undefined) notes.push(`Minimum: ${meta.min}.`);
  else if (meta.max !== undefined) notes.push(`Maximum: ${meta.max}.`);
  const required = meta.requiredWhen ? conditionText(meta.requiredWhen) : null;
  if (required && !/required when/i.test(meta.description)) notes.push(`Required when ${required}.`);
  if (meta.relevantWhen && conditionText(meta.relevantWhen) !== required) {
    notes.push(`Used only when ${conditionText(meta.relevantWhen)}.`);
  }
  if (meta.secret) notes.push('Secret: never logged or returned by the API.');
  const pages = settingsPagesOf.get(name);
  if (pages) notes.push(`Named on ${pages.map((label) => `**Settings → ${label}**`).join(', ')}.`);
  return notes;
}

const cell = (text) => codeifyBareLinks(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const anchorId = (name) => name.toLowerCase().replace(/_/g, '-');

function varRow(name) {
  const meta = PIWI_ENV_VARS[name];
  const variable = `<code id="${anchorId(name)}">${name}</code>`;
  const def = meta.default !== undefined ? `\`${meta.default}\`` : '—';
  const parts = [meta.description];
  if (meta.notes) parts.push(meta.notes);
  parts.push(...metaNotes(meta, name));
  if (meta.since) parts.push(`*Added in ${meta.since}.*`);
  if (meta.until) parts.push(`*Removed in ${meta.until}.*`);
  if (meta.docs) parts.push(`See [details](/${meta.docs}).`);
  return `| ${variable} | ${cell(def)} | ${cell(parts.join(' '))} |`;
}

function sectionMarkdown(category, meta) {
  const rows = [...varsOfCategory(category), ...(mergedInto.get(category) ?? []).flatMap(varsOfCategory)];
  const lines = [`## ${meta.title}`, ''];
  if (meta.intro) lines.push(meta.intro, '');
  lines.push('| Variable | Default | Description |', '|----------|---------|-------------|');
  for (const name of rows) lines.push(varRow(name));
  lines.push('');
  if (meta.note) lines.push(meta.note, '');
  return lines.join('\n');
}

const internalVars = Object.entries(PIWI_ENV_CATEGORIES)
  .filter(([, meta]) => meta.internal)
  .flatMap(([category]) => varsOfCategory(category));

const page = `---
title: Configuration reference
description: Every PIWI_* environment variable the dashboard reads, with its default and what it does, generated from the typed registry.
lang: en-US
editLink: false
---

<!-- GENERATED FILE — do not edit. -->
<!-- Source of truth: apps/application/shared/piwi-env-vars.ts, rendered by apps/docs/scripts/generate-configuration.mjs (npm run docs:gen). -->

# Configuration reference

<ConfigModeSwitch mode="reference" />

Piwi is configured entirely through environment variables. It runs with **zero configuration** out of the box — SQLite and local file storage are created automatically under \`.data/\`. Set variables only to change a default.

Variables can go in \`apps/application/.env\` (see \`apps/application/.env.example\`) or be passed to the container/process. Where a value can also be set in the Settings UI, **the environment variable always wins** and the UI shows that field read-only.

Prefer a guided setup? The [configuration generator](./configuration/generator) builds a ready-to-paste \`.env\`, Docker, Kubernetes or systemd configuration from the same registry as this page — entirely in your browser.

::: tip Settings UI tooltips
In the dashboard, every overridable setting shows a help icon next to its label. Hover it to see which \`PIWI_*\` env var backs the field, a one-line description, and a link back to this page. Fields that are currently pinned by the environment show a lock badge with the variable name, and the Settings nav marks env-managed pages with a lock icon. This page is generated from the typed registry in \`apps/application/shared/piwi-env-vars.ts\` (version ${appVersion}), the same source those tooltips use.
:::

${sections.map(([category, meta]) => sectionMarkdown(category, meta)).join('\n')}
::: tip
${internalVars.map((name) => `\`${name}\``).join(', ')} exist only for the functional test harness and are not used by a normal deployment.
:::
`;

mkdirSync(join(here, '..', 'reference'), { recursive: true });
writeFileSync(join(here, '..', 'reference', 'configuration.md'), page);
console.log(`generated apps/docs/reference/configuration.md from ${varNames.length} registry entries (v${appVersion})`);
