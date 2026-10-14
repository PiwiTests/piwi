import { h } from 'vue';
import { UIcon } from '#components';
import type { Column } from '@tanstack/vue-table';
import type { CommitListItem } from '~~/types/api';
import { formatDistanceToNow, formatDuration as formatDurationLib, intervalToDuration } from 'date-fns';
import { TEST_PRIORITIES, type TestPriority } from '@piwitests/core/test-meta';
import { formatAbsolute } from '#shared/i18n/locale-format';
import { foldText } from '#shared/utils/fold-text';
import { activeLocalePrefs } from './locale-format';
import { statusPalette, statusPaletteKey } from './status-palette';

/**
 * A link that lives inside a sentence keeps the sentence's color and carries a
 * dotted underline that turns solid on hover — never `text-primary`, which is for
 * navigation lists and tables. The situation, story, state and what-changed lines
 * and both failure pages share this one class string.
 */
export const SENTENCE_LINK_CLASS = 'underline decoration-dotted underline-offset-2 hover:decoration-solid';

/**
 * Code inside a heading or a sentence of the situation block — a locator, a
 * commit — sits in a small chip, so it reads as code at a glance without a second
 * font color for the prose around it. The chip wraps with its text on a narrow
 * screen, each line keeping its own edges.
 */
export const CODE_CHIP_CLASS = 'font-mono rounded-md border border-default bg-elevated px-1 box-decoration-clone';

/**
 * The color of a card's header icon: `SectionCard`'s default, and the cards that
 * draw their own header (the evidence card). Every header icon is marked
 * `data-card-icon`.
 */
export const CARD_ICON_CLASS = 'text-primary';

/**
 * The selected tab of a content-level tab strip: a neutral raised surface and the
 * strongest text, never the primary color, which belongs to the page's primary
 * action. The evidence card's tab strip uses it.
 */
export const SELECTED_TAB_CLASS = 'bg-elevated text-highlighted font-medium';

/**
 * The selected option of a segmented control or view switch (a row of options
 * on a raised track, such as the timeline's window switch): the option lifted
 * onto the page's own surface, in the strongest text, never the primary color.
 */
export const SEGMENTED_SELECTED_CLASS = 'bg-default shadow-sm text-highlighted font-medium';

/**
 * The selected row of a list that picks what the page shows (an affected test,
 * the opened attempt): a raised surface inside a neutral ring, never the primary
 * color.
 */
export const SELECTED_ROW_CLASS = 'bg-elevated ring-1 ring-inset ring-accented';

/**
 * The current item in a strip of small status-colored marks (this execution in
 * its test's history, this attempt among the retries): a ring in the strongest
 * neutral, set off the mark by the page's own background so it reads on any
 * status color in both themes.
 */
export const CURRENT_ITEM_RING_CLASS = 'ring-2 ring-offset-1 ring-offset-bg ring-inverted';

/**
 * A row of the evidence card a citation just opened (a request, a console
 * entry): a neutral ring the card takes off again after `CITED_ROW_MS`.
 */
export const CITED_ROW_CLASS = 'ring-2 ring-inset ring-inverted';

/** How long a row a citation opened stays ringed, in ms. */
export const CITED_ROW_MS = 2000;

/** The `diagnosis` shape the toolbox's folded summary reads. */
export interface ToolboxDiagnosisLike {
  status?: string | null;
  summary?: string | null;
  category?: string | null;
  confidence?: string | null;
}

/** The Toolbox's one-line Diagnosis summary — the same wording on both failure pages. */
export function diagnosisSectionSummary(
  diagnosis: ToolboxDiagnosisLike | null | undefined,
  aiConfigured: boolean | undefined,
): string {
  if (diagnosis?.status === 'completed' && (diagnosis.summary || diagnosis.category)) {
    const title = diagnosis.summary ?? diagnosis.category ?? 'Diagnosed';
    return diagnosis.confidence ? `${title} · ${diagnosis.confidence} confidence` : title;
  }
  return aiConfigured === false ? 'AI is not configured' : 'Not diagnosed yet';
}

/** The Toolbox's one-line Reproduce summary. */
export function reproduceSectionSummary(steps: number, bisectAvailable: boolean): string {
  return `${steps} commands · Linux/macOS or Windows · ${bisectAvailable ? 'bisect available' : 'bisect not available'}`;
}

/** The Toolbox's one-line Verify summary — the `-g` grep of the command, then whether CI can re-run. */
export function verifySectionSummary(command: string, rerunAvailable: boolean, fallbackLabel: string): string {
  const g = command.match(/-g\s+(".*?"|'.*?'|\S+)/)?.[1];
  const parts = [g ? `-g ${g}` : fallbackLabel];
  if (rerunAvailable) parts.push('Re-run in CI');
  return parts.join(' · ');
}

/**
 * Narrow a stored priority to the union `TestMetaBadges` takes. The database
 * column is a plain string, so anything unrecognized drops out rather than
 * rendering a badge nobody defined.
 */
export function toTestPriority(value: string | null | undefined): TestPriority | undefined {
  return TEST_PRIORITIES.includes(value as TestPriority) ? (value as TestPriority) : undefined;
}

/**
 * Creates a sortable column header render function.
 * Use as: { header: createSortHeader('My Column'), ... }
 */
export function createSortHeader<T = unknown>(label: string) {
  return ({ column }: { column: Column<T, unknown> }) => {
    const sorted = column.getIsSorted();
    const iconName =
      sorted === 'asc'
        ? 'i-lucide-chevron-up'
        : sorted === 'desc'
          ? 'i-lucide-chevron-down'
          : 'i-lucide-chevrons-up-down';
    return h(
      'button',
      {
        class:
          'flex items-center gap-1 font-semibold select-none cursor-pointer hover:text-highlighted transition-colors',
        onClick: () => column.toggleSorting(),
      },
      [label, h(UIcon, { name: iconName, class: ['shrink-0 size-3.5', !sorted && 'opacity-40'] })],
    );
  };
}

export { formatBytes } from '#shared/utils/format-bytes';

/**
 * Format an absolute timestamp for display.
 *
 * Accepts a `Date`, an ISO string, a numeric string, or a number. Numeric
 * values are auto-detected as Unix seconds (`< 1e12`) or milliseconds, so it
 * works for both `integer(timestamp)` columns (seconds) and raw millisecond
 * fields such as `startedAt`, as well as `Date` objects (e.g. PostgreSQL).
 *
 * The locale and time zone come from the viewer's effective preferences
 * (`activeLocalePrefs`): the built-in `en-US` reads exactly as before
 * (`M/d/yyyy, h:mm:ss a`), while another locale renders in its own convention
 * (`fr-FR` → `22/09/2026 14:30:05`). Absolute dates render client-only
 * (`ClientDate`), so the viewer's browser locale and zone always apply.
 *
 * @param date The value to format.
 * @param options.dateOnly Omit the time component (date only).
 * @returns A formatted string, or `'N/A'` for empty/invalid input.
 */
export function prettyDateFormat(
  date: string | Date | number | null | undefined,
  options: { dateOnly?: boolean } = {},
): string {
  const prefs = activeLocalePrefs();
  return formatAbsolute(date, { locale: prefs.locale, timeZone: prefs.timeZone, dateOnly: options.dateOnly });
}

export function formatRelativeTime(date: string | Date | number | null | undefined): string {
  if (!date) return 'N/A';
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale: activeLocalePrefs().dateFnsLocale });
}

export function formatDuration(ms?: number | null) {
  if (ms === null || ms === undefined) return 'N/A';
  // Round to whole milliseconds so fractional inputs (SQL averages) never
  // render more than 3 decimals of seconds.
  const rounded = Math.round(Math.abs(ms));
  if (rounded === 0) return '0 seconds';
  const sign = ms < 0 ? '−' : '';
  return sign + formatDurationLib({ seconds: rounded / 1000 });
}

/**
 * A duration in human units — "14 hours", "2 days 3 hours".
 *
 * `formatDuration` hands date-fns a bare `{ seconds }`, which it prints
 * verbatim: correct for the sub-minute test durations it exists for, but a
 * cluster open for half a day renders as "50400 seconds". Normalize through
 * `intervalToDuration` first, and keep only the two largest units so a span
 * stays readable.
 */
export function formatLongDuration(ms?: number | null) {
  if (ms === null || ms === undefined) return 'N/A';
  const rounded = Math.round(Math.abs(ms));
  if (rounded < 1000) return 'less than a second';
  const duration = intervalToDuration({ start: 0, end: rounded });
  const units = (['years', 'months', 'days', 'hours', 'minutes', 'seconds'] as const).filter(
    (u) => (duration[u] ?? 0) > 0,
  );
  const sign = ms < 0 ? '−' : '';
  return sign + formatDurationLib(duration, { format: units.slice(0, 2), delimiter: ' ' });
}

/**
 * Split a duration into a compact numeric value and its unit (`ms`/`s`/`m`),
 * for rendering the number and unit separately (e.g. the unit in a faded color).
 * Returns null for null/undefined input.
 */
export function splitDuration(ms?: number | null): { value: string; unit: string } | null {
  if (ms === null || ms === undefined) return null;
  const n = Math.round(Math.abs(ms));
  const sign = ms < 0 ? '−' : '';
  if (n < 1000) return { value: sign + n, unit: 'ms' };
  const seconds = n / 1000;
  if (seconds < 60) return { value: sign + Math.round(seconds * 10) / 10, unit: 's' };
  return { value: sign + Math.round((seconds / 60) * 10) / 10, unit: 'm' };
}

export function reportIcon(type: string): string {
  switch (type) {
    case 'html':
      return 'i-lucide-layout-dashboard';
    case 'monocart':
      return 'i-lucide-bar-chart-2';
    case 'blob':
      return 'i-lucide-download';
    default:
      return 'i-lucide-file-text';
  }
}

/**
 * Map a browser project name to a recognizable icon.
 */
export function getBrowserIcon(browserName?: string | null): string {
  if (!browserName) return 'i-lucide-globe';
  const name = browserName.toLowerCase();
  if (name.includes('chrome') || name.includes('chromium')) return 'i-simple-icons-googlechrome';
  if (name.includes('firefox')) return 'i-simple-icons-firefoxbrowser';
  if (name.includes('safari') || name.includes('webkit')) return 'i-simple-icons-safari';
  if (name.includes('edge')) return 'i-simple-icons-microsoftedge';
  return 'i-lucide-globe';
}

export function getBrowserHexColor(browserName?: string | null): string {
  if (!browserName) return '#6b7280';
  const name = browserName.toLowerCase();
  if (name.includes('chrome') || name.includes('chromium')) return '#4285F4';
  if (name.includes('firefox')) return '#FF7139';
  if (name.includes('safari') || name.includes('webkit')) return '#007AFF';
  if (name.includes('edge')) return '#0078D7';
  return '#6b7280';
}

/**
 * Badge color for a test or run status, on the same hues as the test outcome
 * palette (`status-palette.ts`): timed-out and interrupted read as failed.
 */
export function getStatusColor(status: string): BadgeColor {
  switch (statusPaletteKey(status)) {
    case 'passed':
      return 'success';
    case 'failed':
      return 'error';
    case 'flaky':
      return 'flaky';
    case 'didnotrun':
      return 'warning';
    case 'running':
      return 'info';
    default:
      return 'neutral';
  }
}

/** Playwright reports `timedOut`; the DB and the UI both store `timedout`. */
function normalizeStatusKey(status: string): string {
  return status === 'timedOut' ? 'timedout' : status;
}

/**
 * Lucide icon for a test/run status, so a status drawn as an icon (the run
 * tree, `StatusChip`) always looks the same.
 */
export function getStatusIcon(status: string): string {
  switch (normalizeStatusKey(status)) {
    case 'passed':
      return 'i-lucide-check-circle-2';
    case 'failed':
    case 'timedout':
    case 'interrupted':
      return 'i-lucide-x-circle';
    case 'flaky':
      return 'i-lucide-shuffle';
    case 'didnotrun':
      return 'i-lucide-circle-slash';
    case 'running':
    case 'initializing':
    case 'finalizing':
      return 'i-lucide-loader-circle';
    default:
      return 'i-lucide-minus-circle';
  }
}

/** Text colour classes matching `getStatusIcon`, for an icon drawn without a chip. */
export function getStatusTextClass(status: string): string {
  return statusPalette(status).text;
}

/** Whether a status icon should spin (the run is still in flight). */
export function isStatusInFlight(status: string): boolean {
  const s = normalizeStatusKey(status);
  return s === 'running' || s === 'initializing' || s === 'finalizing';
}

/**
 * Human-readable label for a test-case status badge. A timeout reads "timed
 * out" (it counts as a failure in every tally, but the word stays accurate) and
 * `didnotrun` renders as "didn't run".
 */
export function formatStatusLabel(status: string): string {
  if (status === 'timedOut' || status === 'timedout') return 'timed out';
  if (status === 'didnotrun') return "didn't run";
  if (status === 'never-run') return 'never run';
  return status;
}

/** Status label for one execution: a pass that needed a retry reads "passed on retry". */
export function formatExecutionStatus(status: string, retries?: number | null): string {
  return statusPaletteKey(status, retries) === 'flaky' ? 'passed on retry' : formatStatusLabel(status);
}

/** The status chip's label: the execution's status in sentence case ("Passed on retry", "Didn't run"). */
export function statusChipLabel(status: string, retries?: number | null): string {
  const label = formatExecutionStatus(status, retries);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Whether a test-case status is a failure for filtering, sorting and display.
 * Timeouts fold into failures everywhere (the run counters do the same).
 */
export function isFailedStatus(status: string): boolean {
  return status === 'failed' || status === 'timedOut' || status === 'timedout';
}

/**
 * Sort comparator that puts failed (and timed-out) cases first, keeping the
 * relative order within each group (stable sort). Used as the default ordering
 * of a run's test cases so the landing view answers "why did it fail" first.
 */
export function failureFirstCompare(a: string, b: string): number {
  return Number(isFailedStatus(b)) - Number(isFailedStatus(a));
}

/**
 * Short, human-readable label for why a `didnotrun` case never executed. Mirrors
 * the reporter's `DidNotRunReason` taxonomy; an unknown/absent reason falls back
 * to the neutral "didn't run".
 */
export function formatDidNotRunReason(reason?: string | null): string {
  switch (reason) {
    case 'previous-failure':
      return 'Blocked by an earlier failure';
    case 'global-timeout':
      return 'Global timeout reached';
    case 'max-failures':
      return 'Max failures reached';
    case 'interrupted':
      return 'Run interrupted';
    default:
      return "Didn't run";
  }
}

/** Badge color for a failure-cluster triage status (open/resolved/ignored). */
export function clusterStatusColor(status: string | null | undefined): 'success' | 'warning' | 'neutral' {
  const map: Record<string, 'success' | 'warning' | 'neutral'> = {
    open: 'warning',
    resolved: 'success',
    ignored: 'neutral',
  };
  return (status && map[status]) || 'neutral';
}

/**
 * Human-readable label for a failure cluster's triage status — the raw enum
 * (`open`) is a value, not display copy.
 */
export function formatTriageStatus(status: string | null | undefined): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'resolved':
      return 'Resolved';
    case 'ignored':
      return 'Ignored';
    default:
      return status ?? '—';
  }
}

/**
 * How a landed fix should be presented.
 *
 * The three verdicts are deliberately not interchangeable: only
 * `diagnosis-verified` claims the change is the one that fixed it, so it is the
 * only one shown in a confident colour. `stopped-failing` says nothing more
 * than that the tests went green, and the wording has to stay that modest or
 * the badge over-claims.
 *
 * Returns null when nothing has landed, which is what keeps the resolution
 * block absent rather than empty on the clusters nobody has fixed yet.
 */
export function fixVerificationBadge(
  verification: string | null | undefined,
): { label: string; color: 'success' | 'info' | 'error'; icon: string; hint: string } | null {
  switch (verification) {
    case 'diagnosis-verified':
      return {
        label: 'Verified',
        color: 'success',
        icon: 'i-lucide-badge-check',
        hint: 'The tests went green and the change touched the files the diagnosis named.',
      };
    case 'stopped-failing':
      return {
        label: 'Stopped failing',
        color: 'info',
        icon: 'i-lucide-check',
        hint: 'The tests went green. Nothing corroborates which change did it.',
      };
    case 'regressed':
      return {
        label: 'Regressed',
        color: 'error',
        icon: 'i-lucide-undo-2',
        hint: 'A fix was recorded for this cluster and it did not hold — the failure came back.',
      };
    default:
      return null;
  }
}

/** Badge color for a normalized failure-cluster error type (timeout/assertion/…). */
export function clusterErrorTypeColor(
  type: string | null | undefined,
): 'error' | 'warning' | 'info' | 'neutral' | 'secondary' {
  const map: Record<string, 'error' | 'warning' | 'info' | 'neutral' | 'secondary'> = {
    timeout: 'warning',
    assertion: 'error',
    'strict-mode': 'info',
    navigation: 'secondary',
    crash: 'error',
    unknown: 'neutral',
  };
  return (type && map[type]) || 'neutral';
}

/**
 * Curated tag palette — the Tailwind 500 shades, which keep even perceived
 * saturation across hues. `TagBadge` derives its tint/text from whatever it
 * gets, but picking from a fixed set keeps sibling tags looking like one
 * family.
 */
export const TAG_COLOR_PALETTE = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#84cc16', // lime
  '#10b981', // emerald
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#d946ef', // fuchsia
  '#ec4899', // pink
] as const;

/** Pick a random color for a new tag from the curated palette. */
export function randomHexColor(): string {
  return TAG_COLOR_PALETTE[Math.floor(Math.random() * TAG_COLOR_PALETTE.length)]!;
}

/**
 * Convert file path to API file path.
 * Removes the storage path prefix if present to create a relative path for the API
 * If the path is already relative, returns it as-is
 */
export function getFileApiPath(filePath: string): string {
  // If path is already relative (doesn't start with . or /), return as-is
  if (!filePath.startsWith('.') && !filePath.startsWith('/')) {
    return filePath;
  }

  // Remove storage path prefix for backward compatibility with absolute paths
  const storagePath = '.data/storage/';
  return filePath.replace(storagePath, '');
}

/**
 * Build the URL that serves a stored file through the file API, prefixed with
 * the app's base path so DOM-loaded resources (img/video/a) resolve correctly
 * when the app runs under a sub-path (e.g. the demo at /demo/, where the
 * service worker only intercepts requests inside its scope).
 *
 * `baseURL` is the app's base path (`useRuntimeConfig().app.baseURL`) — read
 * it once in setup and pass it in. Pass `contentType` for extension-less
 * attachment paths — it is forwarded as a query param so the server can set
 * the right Content-Type. `compress` asks the server to re-encode an image
 * down before sending it.
 */
export function fileApiUrl(
  filePath: string,
  contentType?: string | null,
  baseURL: string = '/',
  compress: boolean = false,
): string {
  const base = (baseURL || '/').replace(/\/$/, '');
  const params = new URLSearchParams();
  const hasExt = /\.[a-z0-9]+$/i.test(filePath);
  if (contentType && !hasExt) params.set('contentType', contentType);
  if (compress) params.set('compress', '1');
  const query = params.toString();
  return `${base}/api/files/${getFileApiPath(filePath)}${query ? `?${query}` : ''}`;
}

/**
 * Build a URL that opens a stored trace in the bundled Playwright trace viewer.
 *
 * `baseURL` is the app's base path (`useRuntimeConfig().app.baseURL`). It must be
 * applied to both the viewer path and the trace file URL so links keep working
 * when the app is served from a sub-path (e.g. the demo at `/demo/`).
 *
 * `staticAsset` points the viewer at the file's static URL instead of the
 * `/api/files/` endpoint. Demo mode needs this for its committed sample traces:
 * the trace viewer fetches through its own service worker, which bypasses the
 * demo's API-emulating service worker, so only a real static URL is reachable.
 *
 * The trace URL is root-relative, so the server and the browser build the same
 * link; the viewer resolves it against its own origin.
 */
export function getTraceViewerUrl(filePath: string, baseURL: string = '/', staticAsset: boolean = false): string {
  const base = (baseURL || '/').replace(/\/$/, '');
  const filePrefix = staticAsset ? '' : 'api/files/';
  const traceUrl = `${base}/${filePrefix}${getFileApiPath(filePath)}`;
  return `${base}/trace-viewer/?trace=${encodeURIComponent(traceUrl)}`;
}

/**
 * Extract a human-readable message from an unknown error, unwrapping the
 * `{ data: { message } }` / `{ message }` shapes that `$fetch` throws.
 */
export function errorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err && typeof err === 'object') {
    const e = err as { data?: { message?: string }; message?: string };
    return e.data?.message ?? e.message ?? fallback;
  }
  return fallback;
}

/**
 * Filter a commit list by a free-text query against message, author and SHA,
 * ignoring case and accents.
 */
export function filterCommits<T extends CommitListItem>(commits: T[], query: string): T[] {
  const q = foldText(query.trim());
  if (!q) return commits;
  return commits.filter(
    (c) =>
      foldText(c.message).includes(q) || foldText(c.author).includes(q) || c.sha.includes(q) || c.shortSha.includes(q),
  );
}

/**
 * Icon + text/badge colors for an SCM file-change status (added/removed/renamed/…).
 */
export function scmFileStatusMeta(status: string): {
  icon: string;
  color: string;
  badgeColor: 'success' | 'error' | 'info' | 'neutral';
} {
  switch (status) {
    case 'added':
      return { icon: 'i-lucide-file-plus', color: 'text-green-500', badgeColor: 'success' };
    case 'removed':
      return { icon: 'i-lucide-file-minus', color: 'text-red-500', badgeColor: 'error' };
    case 'renamed':
      return { icon: 'i-lucide-file-symlink', color: 'text-blue-500', badgeColor: 'info' };
    default:
      return { icon: 'i-lucide-file-pen-line', color: 'text-gray-400', badgeColor: 'neutral' };
  }
}

export type PatchLineType = 'add' | 'remove' | 'hunk' | 'context';

export interface PatchLine {
  type: PatchLineType;
  text: string;
}

/** Tailwind classes for each parsed patch-line type. */
export const patchLineClass: Record<PatchLineType, string> = {
  add: 'bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300',
  remove: 'bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300',
  hunk: 'bg-blue-50 dark:bg-blue-950/20 text-blue-500 dark:text-blue-400',
  context: 'text-gray-600 dark:text-gray-400',
};

/** The mark on a diff row a failing test ran (a suspect line): a bar on its left edge, in the text's color. */
export const SUSPECT_ROW_CLASS = 'shadow-[inset_3px_0_0_0_var(--ui-text-highlighted)]';

const HUNK_COUNTS = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Split a unified-diff patch into typed lines for colored rendering. Inside a
 * hunk, the line counts of its header say how many rows follow, so a removed
 * line that starts with `--` (the row `---`) is a removal and an added `++`
 * line an addition; outside one, `---` and `+++` are file headers.
 */
export function parsePatchLines(patch: string): PatchLine[] {
  let oldLeft = 0;
  let newLeft = 0;
  return patch.split('\n').map((line): PatchLine => {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-') && oldLeft > 0) {
        oldLeft--;
        return { type: 'remove', text: line };
      }
      if (line.startsWith('+') && newLeft > 0) {
        newLeft--;
        return { type: 'add', text: line };
      }
      if ((line.startsWith(' ') || line === '') && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
        return { type: 'context', text: line };
      }
      if (line.startsWith('\\')) return { type: 'context', text: line };
      oldLeft = 0;
      newLeft = 0;
    }
    const counts = HUNK_COUNTS.exec(line);
    if (counts) {
      oldLeft = counts[1] === undefined ? 1 : Number(counts[1]);
      newLeft = counts[2] === undefined ? 1 : Number(counts[2]);
    }
    if (line.startsWith('@@')) return { type: 'hunk', text: line };
    if (line.startsWith('+') && !line.startsWith('+++')) return { type: 'add', text: line };
    if (line.startsWith('-') && !line.startsWith('---')) return { type: 'remove', text: line };
    return { type: 'context', text: line };
  });
}

const ESC = '\u001B';

const ANSI_FG: Record<number, string> = {
  30: '#000000',
  31: '#dc2626',
  32: '#16a34a',
  33: '#d97706',
  34: '#2563eb',
  35: '#9333ea',
  36: '#0891b2',
  37: '#9ca3af',
};

const ANSI_BG: Record<number, string> = {
  40: '#000000',
  41: '#dc2626',
  42: '#16a34a',
  43: '#d97706',
  44: '#2563eb',
  45: '#9333ea',
  46: '#0891b2',
  47: '#9ca3af',
};

const ANSI_SGR_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, 'g');

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert ANSI SGR escape sequences to HTML `<span>` tags with inline styles.
 * Handles bold/dim/italic/underline and standard 30–47 color codes.
 * Unrecognized codes are stripped.
 */
export function renderAnsi(text: string): string {
  const parts: string[] = [];
  let last = 0;
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  let italic = false;
  let uline = false;

  const push = (raw: string) => {
    if (!raw) return;
    const props: string[] = [];
    if (bold) props.push('font-weight:600');
    if (dim) props.push('opacity:.7');
    if (italic) props.push('font-style:italic');
    if (uline) props.push('text-decoration:underline');
    if (fg) props.push(`color:${fg}`);
    if (bg) props.push(`background:${bg}`);
    const e = escapeHtml(raw);
    parts.push(props.length ? `<span style="${props.join(';')}">${e}</span>` : e);
  };

  const apply = (codes: number[]) => {
    for (const c of codes) {
      if (c === 0) {
        fg = undefined;
        bg = undefined;
        bold = false;
        dim = false;
        italic = false;
        uline = false;
      } else if (c === 1) {
        bold = true;
      } else if (c === 2) {
        dim = true;
      } else if (c === 3) {
        italic = true;
      } else if (c === 4) {
        uline = true;
      } else if (c === 22) {
        bold = false;
        dim = false;
      } else if (c === 23) {
        italic = false;
      } else if (c === 24) {
        uline = false;
      } else if (c >= 30 && c <= 37) {
        fg = ANSI_FG[c];
      } else if (c === 39) {
        fg = undefined;
      } else if (c >= 40 && c <= 47) {
        bg = ANSI_BG[c];
      } else if (c === 49) {
        bg = undefined;
      }
    }
  };

  let m: RegExpExecArray | null;
  while ((m = ANSI_SGR_RE.exec(text)) !== null) {
    push(text.slice(last, m.index));
    last = ANSI_SGR_RE.lastIndex;
    const codes = m[1] ? m[1].split(';').map(Number) : [0];
    apply(codes);
  }

  push(text.slice(last));
  return parts.join('');
}

export function copyPreview(text: string | null | undefined, max = 120): string {
  if (!text) return '';
  const singleLine = text.replace(/\n/g, ' · ');
  return singleLine.length <= max ? singleLine : singleLine.slice(0, max) + '…';
}

/** Nuxt UI `color` union shared by `UBadge` / `UButton` call sites (`flaky` is registered in nuxt.config.ts). */
export type BadgeColor = 'error' | 'neutral' | 'primary' | 'success' | 'warning' | 'secondary' | 'info' | 'flaky';

/** Pass rate (0–100) for a single run, guarding against divide-by-zero. */
export function passRate(run: { passedTests: number; totalTests: number }): number {
  return run.totalTests > 0 ? Math.round((run.passedTests / run.totalTests) * 100) : 0;
}

/** Badge color for an HTTP method (network request rows). */
export function httpMethodColor(method: string): 'info' | 'success' | 'error' | 'warning' | 'neutral' {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'info';
    case 'POST':
      return 'success';
    case 'DELETE':
      return 'error';
    case 'PUT':
    case 'PATCH':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Badge color for an HTTP status code; 0/negative (aborted, no response) is neutral. */
export function httpStatusColor(status: number): 'success' | 'warning' | 'error' | 'neutral' {
  if (!status || status <= 0) return 'neutral';
  if (status >= 500) return 'error';
  if (status >= 400) return 'warning';
  return 'success';
}
