/**
 * The failure timeline's type filter: which item types — steps, network
 * requests, console entries, dialogs, backend logs — the axis and the steps
 * table show, and what a hidden set leaves out. Pure, so the timeline card, its
 * chip row and the unit tests share one set of rules.
 *
 * The failing step always shows, whatever is hidden: it is the moment every
 * offset on the timeline reads against, and it carries the page at the failure.
 */
import type { TimelineItem, TimelineLane } from '#shared/failure-timeline';
import { isConsoleErrorType } from '#shared/console-entries';

/** Every item type, in the order the axis stacks its lanes and the chips read. */
export const TIMELINE_TYPES: readonly TimelineLane[] = ['steps', 'network', 'console', 'dialogs', 'backend'];

export interface TimelineTypeMeta {
  /** The lane label on the axis and the chip label. */
  label: string;
  icon: string;
  /** The type's hue — the chip icon's, matching its marks on the axis. */
  iconClass: string;
  /** What one item and several items are called in a sentence. */
  one: string;
  many: string;
}

export const TIMELINE_TYPE_META: Record<TimelineLane, TimelineTypeMeta> = {
  steps: {
    label: 'Steps',
    icon: 'i-lucide-list-checks',
    iconClass: 'text-gray-400 dark:text-gray-500',
    one: 'step',
    many: 'steps',
  },
  network: {
    label: 'Network',
    icon: 'i-lucide-arrow-left-right',
    iconClass: 'text-sky-500',
    one: 'request',
    many: 'requests',
  },
  console: {
    label: 'Console',
    icon: 'i-lucide-terminal',
    iconClass: 'text-amber-500',
    one: 'console entry',
    many: 'console entries',
  },
  dialogs: {
    label: 'Dialogs',
    icon: 'i-lucide-message-square',
    iconClass: 'text-teal-500',
    one: 'dialog',
    many: 'dialogs',
  },
  backend: {
    label: 'Backend',
    icon: 'i-lucide-server',
    iconClass: 'text-violet-500',
    one: 'backend log',
    many: 'backend logs',
  },
};

type FilterableItem = Pick<TimelineItem, 'lane' | 'failed' | 'status'>;

/** A stored hidden-types value, reduced to known types, each once, in lane order. */
export function parseHiddenTypes(raw: unknown): TimelineLane[] {
  if (!Array.isArray(raw)) return [];
  return TIMELINE_TYPES.filter((type) => raw.includes(type));
}

/** Whether an item shows while `hidden` types are filtered out. The failing step always does. */
export function isTimelineItemShown(item: FilterableItem, hidden: ReadonlySet<TimelineLane>): boolean {
  return !hidden.has(item.lane) || (item.lane === 'steps' && item.failed === true);
}

/**
 * The stored hidden types that apply where `present` types are on screen: those
 * among them, or none when they would hide every one. The stored choice is
 * shared by every execution, so it may name types this one lacks.
 */
export function effectiveHiddenTypes(
  stored: readonly TimelineLane[],
  present: readonly TimelineLane[],
): TimelineLane[] {
  const hidden = present.filter((type) => stored.includes(type));
  return hidden.length === present.length ? [] : hidden;
}

/**
 * Hide a shown type, or show a hidden one, among the `present` types. The
 * stored choice for types not present is kept, and the last shown type stays
 * shown.
 */
export function toggleHiddenType(
  stored: readonly TimelineLane[],
  type: TimelineLane,
  present: readonly TimelineLane[],
): TimelineLane[] {
  const hidden = effectiveHiddenTypes(stored, present);
  const next = hidden.includes(type) ? hidden.filter((t) => t !== type) : [...hidden, type];
  if (next.length >= present.length) return parseHiddenTypes(stored);
  return parseHiddenTypes([...stored.filter((t) => !present.includes(t)), ...next]);
}

/** Show only `type`, on every execution that has it. */
export function onlyHiddenTypes(type: TimelineLane): TimelineLane[] {
  return TIMELINE_TYPES.filter((t) => t !== type);
}

/** How many of `items` each type has. */
export function countTimelineTypes(items: readonly Pick<TimelineItem, 'lane'>[]): Record<TimelineLane, number> {
  const counts: Record<TimelineLane, number> = { steps: 0, network: 0, console: 0, dialogs: 0, backend: 0 };
  for (const item of items) counts[item.lane] += 1;
  return counts;
}

/**
 * Whether an item is a problem — a failed step or request, an error or fatal
 * console/backend entry, an uncaught page error — or a warning. Anything else is
 * ordinary.
 */
export function timelineItemSeverity(item: FilterableItem): 'error' | 'warning' | null {
  if (item.failed) return 'error';
  const status = item.status?.toLowerCase();
  if (isConsoleErrorType(status) || status === 'fatal') return 'error';
  if (status === 'warning' || status === 'warn') return 'warning';
  return null;
}

/** What the filter leaves out of one type: how many items, and how many of them are problems. */
export interface HiddenTypeSummary {
  type: TimelineLane;
  count: number;
  errors: number;
  warnings: number;
}

/** What `hidden` leaves out of `items`, per type in lane order; types with nothing left out are omitted. */
export function summarizeHiddenItems(
  items: readonly FilterableItem[],
  hidden: ReadonlySet<TimelineLane>,
): HiddenTypeSummary[] {
  const byType = new Map<TimelineLane, HiddenTypeSummary>();
  for (const item of items) {
    if (isTimelineItemShown(item, hidden)) continue;
    const entry = byType.get(item.lane) ?? { type: item.lane, count: 0, errors: 0, warnings: 0 };
    entry.count += 1;
    const severity = timelineItemSeverity(item);
    if (severity === 'error') entry.errors += 1;
    else if (severity === 'warning') entry.warnings += 1;
    byType.set(item.lane, entry);
  }
  return TIMELINE_TYPES.flatMap((type) => byType.get(type) ?? []);
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A run of the hidden line's text; a problem count carries its severity, for its color. */
export interface HiddenSummaryRun {
  text: string;
  severity?: 'error' | 'warning';
}

/**
 * The hidden line as text runs — "4 requests (1 failed), 2 backend logs (1 error,
 * 1 warning)" — each problem count a run of its own: failed requests, and the
 * errors and warnings among console and backend entries.
 */
export function hiddenSummaryRuns(summaries: readonly HiddenTypeSummary[]): HiddenSummaryRun[] {
  const runs: HiddenSummaryRun[] = [];
  summaries.forEach((summary, i) => {
    const meta = TIMELINE_TYPE_META[summary.type];
    runs.push({ text: `${i > 0 ? ', ' : ''}${counted(summary.count, meta.one, meta.many)}` });
    const problems: HiddenSummaryRun[] = [];
    if (summary.errors > 0) {
      const text = summary.type === 'network' ? `${summary.errors} failed` : counted(summary.errors, 'error', 'errors');
      problems.push({ text, severity: 'error' });
    }
    if (summary.warnings > 0) {
      problems.push({ text: counted(summary.warnings, 'warning', 'warnings'), severity: 'warning' });
    }
    problems.forEach((problem, j) => runs.push({ text: j === 0 ? ' (' : ', ' }, problem));
    if (problems.length > 0) runs.push({ text: ')' });
  });
  return runs;
}
