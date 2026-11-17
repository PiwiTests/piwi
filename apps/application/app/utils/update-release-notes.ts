/**
 * The release notes the desktop shell reads for an available update
 * (`desktop_get_release_notes`), the summary the update card shows of them, and
 * the shape `ReleaseNotesAccordion` shows a release in, for them and for the
 * changelog shipped with the build, with the changelog's dates.
 */
import { changelogReleaseCovers, parseReleaseNotes, splitEntryScope, type ChangelogRelease } from '#shared/changelog';
import { formatAbsolute, toIntlLocale, type LocalePref } from '#shared/i18n/locale-format';
import { PROJECT_LINKS } from '#shared/piwi-ecosystem';
import { safeHttpUrl } from '#shared/utils/safe-url';
import { inlineMarkdownHtml } from './markdown-inline';

/** One release between the installed and the offered version, as the shell sends it. */
export interface DesktopReleaseNote {
  version: string;
  /** When it was published (ISO 8601). */
  date: string | null;
  url: string;
  /** Its notes as Markdown, empty when it has none. */
  body: string;
}

/** What `desktop_get_release_notes` answers. */
export interface DesktopReleaseNotes {
  installed: string;
  offered: string;
  /** Newest first. */
  releases: DesktopReleaseNote[];
  /** False when only the newest releases were read. */
  complete: boolean;
}

export const RELEASES_PAGE_URL = PROJECT_LINKS.releases;

/** The GitHub comparison of two versions' tags. */
export function compareUrl(installed: string, offered: string): string {
  return `${PROJECT_LINKS.repository}/compare/v${installed}...v${offered}`;
}

/** A release page link, or the releases page when the shell's URL is not an http(s) one. */
export function releasePageUrl(note: DesktopReleaseNote): string {
  return safeHttpUrl(note.url) ?? RELEASES_PAGE_URL;
}

const NO_ENTITIES = { known: new Set<string>(), baseURL: '/' };

/**
 * A line of release notes as safe HTML: escaped first, then its code, bold and
 * http(s) links, each link in the sentence's color.
 */
export function releaseNoteHtml(markdown: string): string {
  return inlineMarkdownHtml(markdown, NO_ENTITIES);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/**
 * A changelog date (`2026-09-22`, or a span such as `2026-06-23 – 2026-06-28`
 * or `2025-12 – 2026-04`) in the viewer's locale. A day or a month names a
 * calendar date, not an instant, so it is formatted in UTC from its middle and
 * reads the same in every time zone. A part of another shape stays as written.
 */
export function formatReleaseDate(date: string, locale: LocalePref): string {
  return date
    .split(' – ')
    .map((raw) => {
      const part = raw.trim();
      if (DAY.test(part)) return formatAbsolute(`${part}T12:00:00Z`, { locale, timeZone: 'UTC', dateOnly: true });
      if (!MONTH.test(part)) return part;
      try {
        return new Intl.DateTimeFormat(toIntlLocale(locale), {
          year: 'numeric',
          month: 'numeric',
          timeZone: 'UTC',
        }).format(new Date(`${part}-15T12:00:00Z`));
      } catch {
        return part;
      }
    })
    .join(' – ');
}

/** A release as `ReleaseNotesAccordion` shows it. */
export interface ReleaseNotesItem {
  /** The fold's value, unique in the list. */
  key: string;
  label: string;
  /** An ISO 8601 timestamp, a `YYYY-MM-DD` day, or the text of a span of days. */
  date: string | null;
  pageUrl: string;
  parsed: ChangelogRelease;
  /** Marks the release of the version this dashboard runs. */
  current?: boolean;
}

/** A release of the update on offer, as `ReleaseNotesAccordion` shows it. */
export function updateReleaseItem(note: DesktopReleaseNote): ReleaseNotesItem {
  return {
    key: note.version,
    label: `v${note.version}`,
    date: note.date,
    pageUrl: releasePageUrl(note),
    parsed: parseReleaseNotes(note),
  };
}

/** A release of the changelog shipped with the build, as `ReleaseNotesAccordion` shows it. */
export function changelogReleaseItem(release: ChangelogRelease, runningVersion: string): ReleaseNotesItem {
  return {
    key: release.to,
    label: release.from === release.to ? `v${release.version}` : release.version,
    date: release.date,
    pageUrl: safeHttpUrl(release.url) ?? RELEASES_PAGE_URL,
    parsed: release,
    current: !!runningVersion && changelogReleaseCovers(release, runningVersion),
  };
}

/** A breaking change, with the version that made it. */
export interface BreakingChange {
  version: string;
  text: string;
}

export interface ReleaseNotesSummary {
  count: number;
  /** Every release's breaking changes, newest release first. */
  breaking: BreakingChange[];
  /** What the card lists of the newest release: its highlights, else its intro, else its features. */
  preview: string[];
}

const PREVIEW_SIZE = 3;

/** A highlight's bold title (`**🌿 Branches** — …` reads `🌿 Branches`), or the entry without its scope. */
function previewLine(entry: string): string {
  const title = entry.match(/^\*\*([^*]+)\*\*/);
  if (title && !title[1]!.trim().endsWith(':')) return title[1]!.trim();
  return splitEntryScope(entry).text;
}

/** The card's summary of the releases (newest first) an update brings. */
export function summarizeReleaseNotes(releases: ChangelogRelease[]): ReleaseNotesSummary {
  const breaking = releases.flatMap((release) =>
    release.entries.breaking.map((text) => ({ version: release.version, text })),
  );
  const withHighlights = releases.find((release) => release.entries.highlights.length);
  const newest = releases[0];
  let preview: string[] = [];
  if (withHighlights) preview = withHighlights.entries.highlights.slice(0, PREVIEW_SIZE).map(previewLine);
  else if (newest?.intro) preview = [newest.intro];
  else if (newest) preview = newest.entries.features.slice(0, PREVIEW_SIZE).map(previewLine);
  return { count: releases.length, breaking, preview };
}
