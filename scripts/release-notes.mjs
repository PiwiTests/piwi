#!/usr/bin/env node
// Deterministic release-notes tooling shared by CI (.github/workflows/release-notes.yml)
// and the release-notes skill (.claude/skills/release-notes/).
//
// Commands:
//   raw <tag>                      Print the version's changelog entries, de-duplicated.
//   release-body <tag>             Print what belongs in the release body: the polished
//                                  CHANGELOG.md section (headings promoted back up) when it
//                                  is polished, otherwise the de-duplicated raw entries.
//   dedupe [file]                  De-duplicate raw entries from a file or stdin.
//   section <tag>                  Print a version's raw CHANGELOG.md section body.
//   apply <tag> --notes <file>     Publish notes to the GitHub release and/or CHANGELOG.md.
//
// A commit link is `[<hash>](<url>)`. release-please emits one entry per commit, so a merge
// commit's pull request title that repeats one of its commits, a squash or a cherry-pick lands
// the same subject several times; de-duplication keeps the first entry and merges the other
// commits' links into it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CHANGELOG = 'CHANGELOG.md';
const POLISHED_MARKER = '<!-- notes:polished -->';

const usage = `Usage:
  node scripts/release-notes.mjs raw <tag>
  node scripts/release-notes.mjs release-body <tag>
  node scripts/release-notes.mjs dedupe [file]
  node scripts/release-notes.mjs section <tag>
  node scripts/release-notes.mjs apply <tag> --notes <file> [--no-release] [--no-changelog] [--force] [--dry-run]`;

// --- CHANGELOG.md section handling -------------------------------------------------

const versionOf = (tag) => tag.replace(/^v/, '');

// A version header is `## [1.2.3](...)` or `## 1.2.3 (...)`; sub-headings (`### Features`)
// and later version headers (`## `) never match it. The section runs to the next `## ` line.
const versionHeaderRe = (version) =>
  new RegExp('^##+ \\[?' + version.replace(/[.\\]/g, '\\$&') + '\\]?[ (\\]]');

function findSection(text, version) {
  const lines = text.split('\n');
  const header = versionHeaderRe(version);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { lines, start, end, headerLine: lines[start], body: lines.slice(start + 1, end).join('\n') };
}

// --- de-duplication ----------------------------------------------------------------

// One `[hash](url)` link. Hashes are 7-40 hex chars.
const LINK = /\[[0-9a-f]{7,40}\]\([^)]+\)/g;
// A trailing parenthetical made only of comma-separated links, e.g. `([a1b2c3d](u), [e4f5g6h](u))`.
const TRAILING_LINKS = /\s*\((?:\[[0-9a-f]{7,40}\]\([^)]+\)(?:,\s*)?)+\)\s*$/;

const isEntry = (line) => /^\s*[*-]\s+\S/.test(line);

function splitEntry(line) {
  const links = line.match(LINK) ?? [];
  const prefix = line.replace(TRAILING_LINKS, '').replace(/\s+$/, '');
  return { prefix, links };
}

const entryKey = (prefix) => prefix.replace(/^\s*[*-]\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Collapse repeated entries in a raw changelog body. Group headings and any other lines
// (blank lines, prose, `<details>`) are preserved in place; only bullet entries are merged.
function dedupe(body) {
  const out = [];
  const seen = new Map(); // key -> index in `out`
  const merged = { prefix: [], links: [] }; // parallel to `out`, only for entry lines

  for (const line of body.split('\n')) {
    if (!isEntry(line)) {
      out.push(line);
      merged.prefix.push(null);
      merged.links.push(null);
      continue;
    }
    const { prefix, links } = splitEntry(line);
    const key = entryKey(prefix);
    if (seen.has(key)) {
      const at = seen.get(key);
      for (const link of links) {
        if (!merged.links[at].includes(link)) merged.links[at].push(link);
      }
      continue; // drop the duplicate line
    }
    seen.set(key, out.length);
    out.push(line);
    merged.prefix.push(prefix);
    merged.links.push([...links]);
  }

  const rendered = out.map((line, i) => {
    if (merged.prefix[i] === null) return line;
    const links = merged.links[i];
    return links.length ? `${merged.prefix[i]} (${links.join(', ')})` : merged.prefix[i];
  });

  return rendered.join('\n').replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
}

const duplicateCount = (body) =>
  body.split('\n').filter(isEntry).length - dedupe(body).split('\n').filter(isEntry).length;

// --- GitHub release access (via gh) ------------------------------------------------

function hasGh() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function releaseBody(tag) {
  try {
    return execFileSync('gh', ['release', 'view', tag, '--json', 'body', '--jq', '.body'], {
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
}

function setReleaseBody(tag, file) {
  execFileSync('gh', ['release', 'edit', tag, '--notes-file', file], { stdio: 'inherit' });
}

// --- notes shaping -----------------------------------------------------------------

const isBlank = (text) => !text || !/\S/.test(text);
const isPolished = (text) => text.includes(POLISHED_MARKER) || /^#{1,6}\s.*Highlights\b/im.test(text);

// Nest polished notes under a `## [version]` CHANGELOG header: every ATX heading drops one
// level (`##` -> `###`) so the notes sit inside the section instead of ending it. Headings
// inside fenced code blocks are left alone.
function demoteHeadings(text) {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/^(#{1,5}) /, '$1# ');
    })
    .join('\n');
}

// Inverse of demoteHeadings: lift a CHANGELOG section's headings back to release-body level
// (`###` -> `##`) so the polished notes read the same on the release page as in the file.
function promoteHeadings(text) {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/^#(#{1,5} )/, '$1');
    })
    .join('\n');
}

function spliceChangelog(version, notes) {
  const text = fs.readFileSync(CHANGELOG, 'utf8');
  const section = findSection(text, version);
  if (!section) throw new Error(`No CHANGELOG.md section found for ${version}.`);
  const body = demoteHeadings(notes.replace(/\s+$/, ''));
  const next = [
    ...section.lines.slice(0, section.start),
    section.headerLine,
    '',
    body,
    '',
    ...section.lines.slice(section.end),
  ];
  fs.writeFileSync(CHANGELOG, next.join('\n').replace(/\n{3,}$/, '\n'));
}

// --- commands ----------------------------------------------------------------------

function rawSource(tag, source) {
  if (source !== 'release') {
    try {
      const section = findSection(fs.readFileSync(CHANGELOG, 'utf8'), versionOf(tag));
      if (section && !isBlank(section.body)) return section.body;
    } catch {
      /* fall through to the release body */
    }
  }
  if (source !== 'changelog') {
    const body = releaseBody(tag);
    if (!isBlank(body)) return body;
  }
  return null;
}

function cmdRaw(tag, source) {
  const body = rawSource(tag, source);
  if (isBlank(body)) throw new Error(`No changelog entries found for ${tag}.`);
  process.stdout.write(dedupe(body));
}

// What CI publishes to a release body. A polished CHANGELOG section (a human ran the
// release-notes skill) is promoted back to release-body heading levels and used verbatim;
// an ordinary section is de-duplicated raw.
function cmdReleaseBody(tag, source) {
  const body = rawSource(tag, source);
  if (isBlank(body)) throw new Error(`No changelog entries found for ${tag}.`);
  if (isPolished(body)) {
    process.stdout.write(promoteHeadings(body.replace(/^\n+/, '').replace(/\s+$/, '')) + '\n');
  } else {
    process.stdout.write(dedupe(body));
  }
}

function cmdApply(tag, opts) {
  const notes = fs.readFileSync(opts.notes, 'utf8');
  if (isBlank(notes)) throw new Error(`Refusing to publish empty notes from ${opts.notes}.`);

  const problems = [];

  if (opts.release) {
    const current = hasGh() ? releaseBody(tag) : null;
    const guarded = current !== null && isPolished(current) && !isPolished(notes) && !opts.force;
    if (guarded) {
      console.error(`Skipping the ${tag} release body: it looks hand-authored (pass --force to replace).`);
    } else if (current !== null && current.trim() === notes.trim()) {
      console.error(`The ${tag} release body already matches; nothing to write.`);
    } else if (!hasGh()) {
      problems.push(`gh CLI not found — write the release body with: gh release edit ${tag} --notes-file ${opts.notes}`);
    } else if (opts.dryRun) {
      console.error(`[dry-run] would set the ${tag} release body from ${opts.notes}.`);
    } else {
      setReleaseBody(tag, opts.notes);
      console.error(`Updated the ${tag} release body.`);
    }
  }

  if (opts.changelog) {
    if (opts.dryRun) {
      const preview = path.join(os.tmpdir(), `CHANGELOG.${versionOf(tag)}.preview.md`);
      const original = fs.readFileSync(CHANGELOG, 'utf8');
      try {
        spliceChangelog(versionOf(tag), notes);
        fs.copyFileSync(CHANGELOG, preview);
      } finally {
        fs.writeFileSync(CHANGELOG, original);
      }
      console.error(`[dry-run] wrote a CHANGELOG.md preview to ${preview}.`);
    } else {
      spliceChangelog(versionOf(tag), notes);
      console.error(`Updated the ${versionOf(tag)} section of ${CHANGELOG}.`);
    }
  }

  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exitCode = 1;
  }
}

// --- argument parsing --------------------------------------------------------------

function parseApply(args) {
  const opts = { release: true, changelog: true, force: false, dryRun: false, notes: null };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--notes') opts.notes = args[++i];
    else if (a === '--no-release') opts.release = false;
    else if (a === '--no-changelog') opts.changelog = false;
    else if (a === '--release-only') opts.changelog = false;
    else if (a === '--changelog-only') opts.release = false;
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else rest.push(a);
  }
  return { opts, rest };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const sourceFlag = args.includes('--from-release')
    ? 'release'
    : args.includes('--from-changelog')
      ? 'changelog'
      : 'auto';
  const positional = args.filter((a) => !a.startsWith('--'));

  switch (command) {
    case 'raw':
      if (!positional[0]) throw new Error('raw needs a tag.\n\n' + usage);
      cmdRaw(positional[0], sourceFlag);
      break;
    case 'release-body':
      if (!positional[0]) throw new Error('release-body needs a tag.\n\n' + usage);
      cmdReleaseBody(positional[0], sourceFlag);
      break;
    case 'dedupe': {
      const body = positional[0] ? fs.readFileSync(positional[0], 'utf8') : fs.readFileSync(0, 'utf8');
      const dropped = duplicateCount(body);
      if (dropped) console.error(`Collapsed ${dropped} duplicate ${dropped === 1 ? 'entry' : 'entries'}.`);
      process.stdout.write(dedupe(body));
      break;
    }
    case 'section': {
      if (!positional[0]) throw new Error('section needs a tag.\n\n' + usage);
      const section = findSection(fs.readFileSync(CHANGELOG, 'utf8'), versionOf(positional[0]));
      if (!section) throw new Error(`No CHANGELOG.md section found for ${positional[0]}.`);
      process.stdout.write(section.body.replace(/^\n+/, '').replace(/\s+$/, '') + '\n');
      break;
    }
    case 'apply': {
      const { opts, rest } = parseApply(args);
      if (!rest[0]) throw new Error('apply needs a tag.\n\n' + usage);
      if (!opts.notes) throw new Error('apply needs --notes <file>.\n\n' + usage);
      cmdApply(rest[0], opts);
      break;
    }
    default:
      console.error(usage);
      process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
