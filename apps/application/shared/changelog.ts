/**
 * The project changelog (`CHANGELOG.md` at the repository root), parsed into
 * releases. It feeds the MCP `get_release_notes` tool, which ships the file
 * inside the server build so it answers for the running version, and the docs'
 * generated What's new page (`apps/docs/scripts/generate-whats-new.mjs`). The
 * desktop app's update card reads a GitHub release body the same way, through
 * `parseReleaseNotes`.
 *
 * The file mixes two shapes: release-please's raw sections (`### Features`,
 * `### Bug Fixes`, one `* **scope:** subject ([hash](url))` line per commit, so
 * squash and cherry-pick repeat a subject) and hand-polished ones (a narrative
 * intro, `### ✨ Highlights`, `####` groups, `-` bullets). Both parse to the same
 * shape: commit, pull-request and `closes` links dropped, repeats collapsed.
 */
import { compareVersions } from '#shared/piwi-env-vars';

/** The kinds of entry a release lists, in the order a reader wants them. */
export const CHANGELOG_ENTRY_KINDS = ['highlights', 'breaking', 'features', 'fixes', 'performance', 'other'] as const;

export type ChangelogEntryKind = (typeof CHANGELOG_ENTRY_KINDS)[number];

export interface ChangelogRelease {
  /** The version as the header names it: `0.36.0`, or a span such as `0.4.0 – 0.4.4`. */
  version: string;
  /** Lowest and highest version the entry covers — equal for a single release. */
  from: string;
  to: string;
  /** Release date as written, e.g. `2026-09-22` (a span for a grouped entry). */
  date: string | null;
  /** The compare or releases link from the header. */
  url: string | null;
  /** The narrative paragraph polished notes open with, as Markdown. */
  intro: string | null;
  /** Entries per kind, as Markdown with their commit and issue links removed. */
  entries: Record<ChangelogEntryKind, string[]>;
}

const HEADER = /^##\s+\[([^\]]+)\](?:\(([^)]*)\))?\s*(?:\(([^)]*)\))?/;
const SEMVER = /\d+\.\d+\.\d+/g;
const BULLET = /^\s*[*-]\s+(.*)$/;

// A commit (`[a1b2c3d](…)`) or pull-request/issue (`[#123](…)`) link.
const REF_LINK = String.raw`\[(?:[0-9a-f]{7,40}|#\d+)\]\([^)]*\)`;
// A parenthetical made only of such links: ` ([a1b2c3d](…), [#12](…))`.
const REF_GROUP = new RegExp(String.raw`\s*\((?:${REF_LINK}(?:,\s*)?)+\)`, 'g');
// release-please's `, closes [#581](…)` suffix.
const CLOSES = new RegExp(String.raw`,?\s*closes\s+(?:${REF_LINK}|#\d+)(?:,\s*(?:${REF_LINK}|#\d+))*`, 'gi');

/** An entry with its commit, pull-request and `closes` references removed. */
export function cleanChangelogEntry(text: string): string {
  return text.replace(CLOSES, '').replace(REF_GROUP, '').replace(/\s+/g, ' ').trim();
}

/** The kind a `###` section heading holds. */
export function changelogSectionKind(heading: string): ChangelogEntryKind {
  const h = heading.toLowerCase();
  if (h.includes('breaking')) return 'breaking';
  if (h.includes('highlight')) return 'highlights';
  if (h.includes('fix')) return 'fixes';
  if (h.includes('performance')) return 'performance';
  if (h.includes('feature') || h.trim() === 'improvements') return 'features';
  return 'other';
}

const entryKey = (entry: string) => entry.toLowerCase().replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();

function emptyEntries(): Record<ChangelogEntryKind, string[]> {
  return { highlights: [], breaking: [], features: [], fixes: [], performance: [], other: [] };
}

/** Parse the changelog into releases, newest first as the file lists them. */
export function parseChangelog(text: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let kind: ChangelogEntryKind | null = null;
  let intro: string[] = [];
  let seen = new Set<string>();
  // The entry a continuation line (an indented line under a bullet) belongs to.
  let open: { kind: ChangelogEntryKind; index: number } | null = null;

  const finishIntro = () => {
    if (release && intro.length && release.intro === null) release.intro = intro.join(' ');
    intro = [];
  };

  /** Record an entry unless it repeats one; returns where a continuation line would land. */
  const add = (entryKind: ChangelogEntryKind, raw: string): typeof open => {
    if (!release) return null;
    const entry = cleanChangelogEntry(raw);
    const key = `${entryKind}:${entryKey(entry)}`;
    if (!entry || seen.has(key)) return null;
    seen.add(key);
    release.entries[entryKind].push(entry);
    return { kind: entryKind, index: release.entries[entryKind].length - 1 };
  };

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const header = line.match(HEADER);
    if (header) {
      finishIntro();
      const versions = header[1]!.match(SEMVER) ?? [];
      if (!versions.length) {
        release = null;
        continue;
      }
      const sorted = [...versions].sort(compareVersions);
      release = {
        version: header[1]!.trim(),
        from: sorted[0]!,
        to: sorted[sorted.length - 1]!,
        date: header[3]?.trim() || null,
        url: header[2]?.trim() || null,
        intro: null,
        entries: emptyEntries(),
      };
      releases.push(release);
      kind = null;
      seen = new Set();
      open = null;
      continue;
    }
    if (!release) continue;

    const section = line.match(/^###\s+(.+)$/);
    if (section) {
      finishIntro();
      kind = changelogSectionKind(section[1]!);
      open = null;
      continue;
    }
    if (/^####\s/.test(line) || /^\s*<!--.*-->\s*$/.test(line)) {
      open = null;
      continue;
    }

    const bullet = line.match(BULLET);
    if (bullet) {
      finishIntro();
      open = add(kind ?? 'features', bullet[1]!);
      continue;
    }
    if (!line.trim()) {
      if (!kind && intro.length) finishIntro();
      open = null;
      continue;
    }
    if (open && /^\s{2,}\S/.test(line)) {
      const entries = release.entries[open.kind];
      entries[open.index] = cleanChangelogEntry(`${entries[open.index]} ${line.trim()}`);
      continue;
    }
    if (!kind && !/^\*\*Full diff:\*\*/.test(line.trim())) intro.push(line.trim());
  }
  finishIntro();
  return releases;
}

/** Push every Markdown heading one level down, leaving fenced code blocks alone. */
function demoteHeadings(text: string): string {
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

/** Whether the text has a `## ` heading outside a fenced code block. */
function hasLevelTwoHeading(text: string): boolean {
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence && /^## /.test(line)) return true;
  }
  return false;
}

/**
 * One GitHub release body, parsed as its `CHANGELOG.md` section would be.
 * A polished body titles its sections `##`, one level above the changelog's,
 * so its headings move down a level first.
 */
export function parseReleaseNotes(release: {
  version: string;
  date: string | null;
  url: string;
  body: string;
}): ChangelogRelease {
  const body = release.body.replace(/\r\n/g, '\n');
  const date = release.date ? release.date.slice(0, 10) : null;
  const header = `## [${release.version}](${release.url})${date ? ` (${date})` : ''}`;
  const parsed = parseChangelog(`${header}\n\n${hasLevelTwoHeading(body) ? demoteHeadings(body) : body}`)[0];
  return (
    parsed ?? {
      version: release.version,
      from: release.version,
      to: release.version,
      date,
      url: release.url,
      intro: null,
      entries: emptyEntries(),
    }
  );
}

const ENTRY_SCOPE = /^\*\*([a-z-]+):\*\*\s+/;

/** A raw entry's `**scope:**` prefix, apart from its sentence; `null` scope when it has none. */
export function splitEntryScope(entry: string): { scope: string | null; text: string } {
  const match = entry.match(ENTRY_SCOPE);
  return match ? { scope: match[1]!, text: entry.slice(match[0].length) } : { scope: null, text: entry };
}
