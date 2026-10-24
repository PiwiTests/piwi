/**
 * Generates apps/docs/reference/whats-new.md — the "what's new" page — from the
 * repository CHANGELOG.md.
 *
 * The page is a build artifact (gitignored): `docs:dev` and `docs:build` run
 * this first, so it can never drift from the changelog. It lists the *feature*
 * entries of every release (raw release-please sections and polished notes
 * alike, read by `apps/application/shared/changelog.ts`) grouped by minor
 * version, newest first, with commit links stripped — the answer to "what changed since I last
 * upgraded". Bug fixes and the full history stay in CHANGELOG.md, linked at the
 * top. To change the page, cut a release; do not edit it here.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createJiti } from 'jiti';

const here = dirname(fileURLToPath(import.meta.url));
// here = apps/docs/scripts → up three to the monorepo root, where CHANGELOG.md lives.
const monorepoRoot = join(here, '..', '..', '..');
const jiti = createJiti(import.meta.url);

// The same parser the MCP get_release_notes tool reads the changelog with, so
// raw release-please sections and hand-polished ones (`-` bullets under `####`
// groups) are both read, and repeated entries collapse.
const { parseChangelog } = await jiti.import(join(monorepoRoot, 'apps/application/shared/changelog.ts'));
const releases = parseChangelog(readFileSync(join(monorepoRoot, 'CHANGELOG.md'), 'utf8'));

/** One entry per minor version (X.Y), newest first, with its feature list. */
const minors = new Map();

for (const release of releases) {
  const [major, minor, patch] = release.to.split('.').map(Number);
  // A backfilled entry spanning several minors ("0.1.0 – 0.2.1") keeps its own span as the label.
  const firstMinor = release.from.split('.').slice(0, 2).join('.');
  const key = firstMinor === `${major}.${minor}` ? `${major}.${minor}` : `${firstMinor} – ${major}.${minor}`;
  if (!minors.has(key)) minors.set(key, { label: key, major, minor, date: null, features: [], seen: new Set() });
  const entry = minors.get(key);
  // The minor's date is its .0 release; a grouped entry dates from its first day.
  const date = release.date?.split(' – ')[0] ?? null;
  if (date && (patch === 0 || !entry.date || date < entry.date)) entry.date = date;
  for (const feature of release.entries.features) {
    const key = feature.toLowerCase();
    if (entry.seen.has(key)) continue;
    entry.seen.add(key);
    entry.features.push(feature);
  }
}

const ordered = [...minors.values()]
  .filter((m) => m.features.length > 0)
  .sort((a, b) => b.major - a.major || b.minor - a.minor);

const sections = ordered
  .map((m) => [`## ${m.label}${m.date ? ` — ${m.date}` : ''}`, '', ...m.features.map((f) => `- ${f}`), ''].join('\n'))
  .join('\n');

const page = `---
title: What's new
description: The features each Piwi release added, grouped by minor version and newest first, generated from the changelog.
lang: en-US
editLink: false
---

<!-- GENERATED FILE — do not edit. -->
<!-- Source of truth: CHANGELOG.md, rendered by apps/docs/scripts/generate-whats-new.mjs (npm run docs:gen). -->

# What's new

The features that landed in each release, newest first — the answer to "what
changed since I last upgraded, and is any of it worth reading about". It is
generated from the project [changelog](https://github.com/PiwiTests/piwi/blob/main/CHANGELOG.md),
which also holds the bug fixes and the full commit history.

Piwi is pre-1.0: minor releases can carry breaking changes and the database
schema moves with them, so read [Upgrading](/operate/upgrading) before you bump a tag.

${sections}`;

mkdirSync(join(here, '..', 'reference'), { recursive: true });
writeFileSync(join(here, '..', 'reference', 'whats-new.md'), page);
console.log(`generated apps/docs/reference/whats-new.md from ${ordered.length} minor versions`);
