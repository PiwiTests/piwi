/**
 * The browser tab's view of the test run a page is watching: a badge over the
 * Piwi favicon (a pie of the suite done, in the run's outcome color) and the
 * run's progress ahead of the page title, the way the desktop shell shows a
 * run on its window title and tray. Labels and the outcome flash come from the
 * desktop's own helpers (`desktop-run-progress.ts`), so both read the same.
 * Pure and framework-free so it is unit-tested; `useTabRunIndicator` feeds it
 * the page's live counts and writes the result into the document head.
 */
import { aggregateRunProgress, finishedRunFlash } from './desktop-run-progress';
import type { StatusPaletteKey } from './status-palette';

export interface TabRunIndicator {
  /** The outcome the badge is painted in (a `--color-status-*` token). */
  status: Extract<StatusPaletteKey, 'running' | 'failed' | 'passed'>;
  /** Share of the suite done, 0–1, drawn as a pie; `null` draws a full dot (size unknown, or a finished run). */
  fraction: number | null;
  /** What leads the tab title, e.g. "Running 7/12 · 2 failed". */
  label: string;
}

/** A live run's counts so far: tests finished, the planned suite size (`0` when unknown) and failures. */
export interface TabRunCounts {
  done: number;
  total: number;
  failed: number;
}

/** The indicator of a run in flight: blue while it goes well, the failed color once a test has failed. */
export function liveRunTabIndicator(counts: TabRunCounts): TabRunIndicator {
  const { done, total, failed } = counts;
  const progress = aggregateRunProgress([{ status: 'running', done, total, failed }]);
  return {
    status: progress.failing ? 'failed' : 'running',
    fraction: progress.fraction,
    label: progress.label ?? 'Running…',
  };
}

/**
 * What the tab shows once the watched run ends with `status`, and for how long,
 * or `null` to restore the plain favicon at once (a cancelled run). A pass shows
 * the passed color; interrupted and timed-out runs count as failed.
 */
export function finishedRunTabIndicator(status: string): { indicator: TabRunIndicator; durationMs: number } | null {
  const flash = finishedRunFlash(status);
  if (!flash) return null;
  return {
    indicator: {
      status: status === 'passed' ? 'passed' : 'failed',
      fraction: null,
      label: flash.progress.label ?? 'Run finished',
    },
    durationMs: flash.durationMs,
  };
}

/** The page title with the run's progress ahead of it, in the desktop window title's format. */
export function tabRunTitle(title: string, indicator: TabRunIndicator | null): string {
  return indicator ? `▶ ${indicator.label} · ${title}` : title;
}

/** The favicon's drawing box, and the badge in its bottom-right corner. */
const SIZE = 64;
const BADGE = { cx: 44, cy: 44, r: 18, gap: 3, ring: 3 };

/** The pie wedge for `fraction` of the badge, clockwise from 12 o'clock. */
function wedgePath(fraction: number): string {
  const { cx, cy, r } = BADGE;
  const angle = fraction * 2 * Math.PI;
  const x = cx + r * Math.sin(angle);
  const y = cy - r * Math.cos(angle);
  const large = fraction > 0.5 ? 1 : 0;
  return `M${cx} ${cy}V${cy - r}A${r} ${r} 0 ${large} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`;
}

/**
 * The favicon for `indicator` as SVG markup: the Piwi logo (`logoSvg`, the
 * favicon's own file) with a transparent cut-out in its bottom-right corner
 * holding the badge, so most of the logo stays in view. `color` is the CSS
 * color of the indicator's status token, resolved by the caller since an image
 * cannot read the page's variables. The pie is rounded to whole percents, and
 * an unfinished suite stops at 99 so it never reads as done.
 */
export function runFaviconSvg(logoSvg: string, indicator: TabRunIndicator, color: string): string {
  const { cx, cy, r, gap, ring } = BADGE;
  const f = indicator.fraction == null ? null : Math.min(Math.max(indicator.fraction, 0), 1);
  const fraction = f == null ? null : Math.min(Math.round(f * 100) / 100, f < 1 ? 0.99 : 1);
  let badge: string;
  if (fraction == null || fraction >= 1) {
    badge = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
  } else {
    badge =
      `<circle cx="${cx}" cy="${cy}" r="${r - ring / 2}" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="${ring}"/>` +
      (fraction > 0 ? `<path d="${wedgePath(fraction)}" fill="${color}"/>` : '');
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<mask id="cut"><rect width="${SIZE}" height="${SIZE}" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="${r + gap}" fill="#000"/></mask>` +
    `<image href="${svgDataUrl(logoSvg)}" width="${SIZE}" height="${SIZE}" mask="url(#cut)"/>` +
    badge +
    `</svg>`
  );
}

/** SVG markup as a `data:` address for a `<link rel="icon">`. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
