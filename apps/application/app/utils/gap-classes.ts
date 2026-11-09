/**
 * How the Gaps view and the graph views color a gap class: one mapping for the
 * SVG fills, the badge colors and the plain-language legend, so a red badge in
 * the list is the same red as the node in the graph. Severity order lives in
 * `#shared/gap-classes`; this file only names the paint.
 */
import { gapClassSeverity } from '#shared/gap-classes';

/** Tailwind fill for an SVG node by its worst gap class; no gap reads as protected. */
export function gapClassFill(cls: string | null | undefined): string {
  switch (cls) {
    case 'unhandled':
    case 'false-comfort':
      return 'fill-red-500';
    case 'degraded':
    case 'blind-spot':
      return 'fill-amber-500';
    case 'fragile':
      return 'fill-orange-400';
    default:
      return 'fill-emerald-500';
  }
}

/** Nuxt UI badge color for a gap class. */
export function gapClassBadgeColor(cls: string | null | undefined): 'error' | 'warning' | 'success' | 'neutral' {
  switch (cls) {
    case 'unhandled':
    case 'false-comfort':
      return 'error';
    case 'degraded':
    case 'blind-spot':
    case 'fragile':
      return 'warning';
    case null:
    case undefined:
      return 'success';
    default:
      return 'neutral';
  }
}

/** Tailwind stroke for a graph edge by its kind. */
export function graphEdgeStroke(kind: string): string {
  switch (kind) {
    case 'reaches':
      return 'stroke-emerald-400';
    case 'checks':
      return 'stroke-blue-400';
    case 'triggers':
    case 'loads':
      return 'stroke-violet-400';
    case 'handled-by':
    case 'calls':
      return 'stroke-slate-400';
    case 'groups':
      return 'stroke-sky-400';
    default:
      return 'stroke-gray-300 dark:stroke-gray-600';
  }
}

/** Sort key: most severe class first, then more reaching tests, then the key. */
export function compareBySeverity<T extends { class: string | null; tests: { length: number }; key: string }>(
  a: T,
  b: T,
): number {
  return (
    gapClassSeverity(b.class) - gapClassSeverity(a.class) ||
    b.tests.length - a.tests.length ||
    a.key.localeCompare(b.key)
  );
}
