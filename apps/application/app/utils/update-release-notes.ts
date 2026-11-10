/**
 * The release notes the desktop shell reads for an available update
 * (`desktop_get_release_notes`), and the summary the update card shows of them.
 */
import { splitEntryScope, type ChangelogRelease } from '#shared/changelog';
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
