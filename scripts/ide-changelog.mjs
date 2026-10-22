#!/usr/bin/env node
// The editor extensions' changelog: the `ide` entries of the root CHANGELOG.md (the lines
// `* **ide:** …`), under their version heading and section heading. The publish workflows
// write it as apps/vscode/CHANGELOG.md, which the VSIX ships, and as the JetBrains plugin's
// change notes, the Marketplace's "What's new"; neither is committed.
//
// Usage:
//   node scripts/ide-changelog.mjs [--format md|html] [--version <v>] [--all]
//
//   --format md    Markdown, the default: one version, or every version that has `ide`
//                  entries with --all; a version without any is left out.
//   --format html  One version as HTML (<h3>, <ul>, <li>, <a>, <code>), for the plugin's
//                  change notes; a version without `ide` entries prints a line saying so.
//   --version <v>  The version, with or without its `v`; the latest version by default.
//
// The scope prefix is dropped, since every entry is the extensions'. An entry release-please
// wrote once per commit (squash, cherry-pick) is kept once, with every commit's link.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHANGELOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
const NO_CHANGE = 'No change to the editor extensions in this release.';

const usage = `Usage:
  node scripts/ide-changelog.mjs [--format md|html] [--version <v>] [--all]`;

// --- extraction --------------------------------------------------------------------

/** @typedef {{ text: string, links: string[] }} IdeEntry */
/** @typedef {{ heading: string, entries: IdeEntry[] }} IdeSection */
/** @typedef {{ version: string, heading: string, sections: IdeSection[] }} IdeVersion */

// A version heading is `## [1.2.3](...) (date)` or `## 1.2.3 (date)`; the version runs to the
// next `## ` line. A `### ` heading names a section (Features, Bug Fixes, …); a `#### ` heading
// stays in the section above it.
const VERSION_HEADING = /^## \[?(\d+\.\d+\.\d+[^\]\s]*)/;
const SECTION_HEADING = /^### (.+?)\s*$/;
// A bullet whose scope is `ide`.
const IDE_ENTRY = /^[*-] \*\*ide:\*\* (.+?)\s*$/;
// One `[hash](url)` commit link (7 to 40 hex chars), and the trailing parenthetical made only
// of such links, comma-separated, that ends an entry.
const LINK = /\[[0-9a-f]{7,40}\]\([^)]+\)/g;
const TRAILING_LINKS = /\s*\((?:\[[0-9a-f]{7,40}\]\([^)]+\)(?:,\s*)?)+\)\s*$/;

/**
 * The `ide` entries of every version of a changelog, latest first, each version holding only
 * the sections that have some. An entry with the same text as an earlier one of its version
 * is merged into it: its links join the earlier one's.
 *
 * @param {string} changelog
 * @returns {IdeVersion[]}
 */
export function extractIdeEntries(changelog) {
  /** @type {IdeVersion[]} */
  const versions = [];
  /** @type {IdeVersion | null} */
  let version = null;
  /** @type {IdeSection} */
  let section = { heading: '', entries: [] };
  /** @type {Map<string, IdeEntry>} */
  let seen = new Map();

  for (const line of changelog.split('\n')) {
    const versionHeading = VERSION_HEADING.exec(line);
    if (versionHeading) {
      version = { version: versionHeading[1], heading: line.trimEnd(), sections: [] };
      versions.push(version);
      section = { heading: '', entries: [] };
      seen = new Map();
      continue;
    }
    if (!version) continue;
    const sectionHeading = SECTION_HEADING.exec(line);
    if (sectionHeading) {
      section = { heading: sectionHeading[1], entries: [] };
      continue;
    }
    const entry = IDE_ENTRY.exec(line);
    if (!entry) continue;
    const trailing = TRAILING_LINKS.exec(entry[1])?.[0] ?? '';
    const links = trailing.match(LINK) ?? [];
    const text = entry[1].slice(0, entry[1].length - trailing.length).trim();
    const key = text.replace(/\s+/g, ' ').toLowerCase();
    const earlier = seen.get(key);
    if (earlier) {
      for (const link of links) if (!earlier.links.includes(link)) earlier.links.push(link);
      continue;
    }
    const item = { text, links };
    seen.set(key, item);
    if (!version.sections.includes(section)) version.sections.push(section);
    section.entries.push(item);
  }
  return versions;
}

// --- rendering ---------------------------------------------------------------------

const MARKDOWN_HEADER = `# Changelog

What each Piwi release changed in the editor extensions: the \`ide\` entries of the
[Piwi changelog](https://github.com/PiwiTests/platform/blob/main/CHANGELOG.md).`;

/** @param {IdeEntry} entry */
const entryMarkdown = (entry) => (entry.links.length ? `${entry.text} (${entry.links.join(', ')})` : entry.text);

/**
 * A Markdown changelog of the versions that have `ide` entries, in the order given.
 *
 * @param {IdeVersion[]} versions
 */
export function renderMarkdown(versions) {
  const lines = [MARKDOWN_HEADER];
  for (const version of versions) {
    if (!version.sections.length) continue;
    lines.push('', version.heading);
    for (const section of version.sections) {
      if (section.heading) lines.push('', `### ${section.heading}`);
      lines.push('', ...section.entries.map((entry) => `* ${entryMarkdown(entry)}`));
    }
  }
  return lines.join('\n') + '\n';
}

/** @param {string} text */
const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

// Markdown links become <a> and backticks <code>; the rest is text.
/** @param {string} markdown */
const inlineHtml = (markdown) =>
  escapeHtml(markdown)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

/**
 * One version's `ide` entries as HTML, the plugin's change notes: a `<h3>` per section with its
 * entries as a list, or one line saying the version changed nothing in the extensions.
 *
 * @param {IdeVersion} version
 */
export function renderHtml(version) {
  if (!version.sections.length) return `<p>${NO_CHANGE}</p>\n`;
  const lines = [];
  for (const section of version.sections) {
    if (section.heading) lines.push(`<h3>${inlineHtml(section.heading)}</h3>`);
    lines.push('<ul>', ...section.entries.map((entry) => `  <li>${inlineHtml(entryMarkdown(entry))}</li>`), '</ul>');
  }
  return lines.join('\n') + '\n';
}

// --- command line ------------------------------------------------------------------

/** @param {string[]} args */
function parseArgs(args) {
  const opts = { format: 'md', version: /** @type {string | null} */ (null), all: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--format') opts.format = args[++i] ?? '';
    else if (arg === '--version') opts.version = args[++i] ?? null;
    else if (arg === '--all') opts.all = true;
    else throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
  }
  if (opts.format !== 'md' && opts.format !== 'html') throw new Error(`--format takes md or html.\n\n${usage}`);
  if (opts.all && opts.format === 'html') throw new Error(`--all is for the Markdown format.\n\n${usage}`);
  if (opts.all && opts.version) throw new Error(`--all and --version exclude each other.\n\n${usage}`);
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const versions = extractIdeEntries(fs.readFileSync(CHANGELOG, 'utf8'));
  if (!versions.length) throw new Error(`No version found in ${CHANGELOG}.`);
  if (opts.all) {
    process.stdout.write(renderMarkdown(versions));
    return;
  }
  const wanted = opts.version?.replace(/^v/, '');
  const version = wanted ? versions.find((v) => v.version === wanted) : versions[0];
  if (!version) throw new Error(`No CHANGELOG.md section found for ${wanted}.`);
  process.stdout.write(opts.format === 'html' ? renderHtml(version) : renderMarkdown([version]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
