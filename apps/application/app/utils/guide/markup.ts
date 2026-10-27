/**
 * The markup of guide copy: plain text where `**label**` is the only markup,
 * a dashboard label as the screen spells it.
 */

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const BOLD = /\*\*(.+?)\*\*/g;

/** Escapes text for HTML. */
export function escapeGuideHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/**
 * Guide copy as the popover's HTML (driver.js writes it with `innerHTML`): the
 * text escaped, and each `**label**` a `<strong>`.
 */
export function guideMarkup(text: string): string {
  return escapeGuideHtml(text).replace(BOLD, '<strong>$1</strong>');
}

/** Guide copy for a place that shows no markup, such as an accessible name: the `**` dropped. */
export function plainGuideText(text: string): string {
  return text.replace(BOLD, '$1');
}

/** The `**bold**` dashboard labels a piece of guide copy names, in order. */
export function boldLabels(text: string): string[] {
  return [...text.matchAll(BOLD)].map((match) => match[1]!);
}

/** Fills each `{name}` placeholder from `values`; an unknown name stays as written. */
export function fillGuideText(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
