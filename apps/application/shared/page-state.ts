/**
 * Pure rendering/diff helpers for the page state the reporter captures at test
 * end (URL, history state, storage key names + lengths, cookie names + flags,
 * focus, hover and selection — values are never captured). Shared by the server
 * AI-context builder and the demo mirror so both produce identical evidence.
 */
import type { PageInteraction } from '#shared/page-interaction';

export interface PageStateLike extends PageInteraction {
  url?: string | null;
  hash?: string | null;
  historyState?: string | null;
  localStorage?: Array<{ key: string; length: number }> | null;
  sessionStorage?: Array<{ key: string; length: number }> | null;
  cookies?: Array<{
    name: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  }> | null;
}

/** The focused element, whether its focus ring showed, and its caret or selected range in a field. */
export function describeFocus(focus: NonNullable<PageInteraction['focus']>): string {
  const range = focus.selection;
  const where = !range
    ? ''
    : range[0] === range[1]
      ? `, caret at ${range[0]}`
      : `, text selected from ${range[0]} to ${range[1]}`;
  return `${focus.element.label}${focus.visible ? ' (focus ring shown)' : ''}${where}`;
}

function storageLine(label: string, entries: PageStateLike['localStorage']): string {
  const list = entries ?? [];
  if (list.length === 0) return `- ${label}: empty`;
  const shown = list.map((e) => `${e.key} (${e.length} ch)`).join(', ');
  return `- ${label} (${list.length}): ${shown}`;
}

function cookieFlags(c: NonNullable<PageStateLike['cookies']>[number]): string {
  const flags = [c.httpOnly ? 'HttpOnly' : null, c.secure ? 'Secure' : null, c.sameSite ?? null].filter(Boolean);
  return flags.length > 0 ? `${c.name} [${flags.join(', ')}]` : c.name;
}

/** Added/removed key names between two lists (order-insensitive). */
function keyDiff(failing: string[], baseline: string[]): string | null {
  const f = new Set(failing);
  const b = new Set(baseline);
  const added = failing.filter((k) => !b.has(k));
  const removed = baseline.filter((k) => !f.has(k));
  if (added.length === 0 && removed.length === 0) return null;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added ${added.join(', ')}`);
  if (removed.length > 0) parts.push(`missing ${removed.join(', ')}`);
  return parts.join('; ');
}

/**
 * Render the failing execution's app state, with a diff block when the last
 * passing execution captured one too. Returns null when there is no state.
 */
export function renderAppStateMarkdown(failing: PageStateLike | null, baseline?: PageStateLike | null): string | null {
  if (!failing) return null;

  const lines: string[] = ['## App State (at test end)'];
  if (failing.url) lines.push(`- URL: ${failing.url}${failing.hash ? ` (hash ${failing.hash})` : ''}`);
  if (failing.historyState) lines.push(`- History state: ${failing.historyState}`);
  lines.push(storageLine('localStorage keys', failing.localStorage));
  lines.push(storageLine('sessionStorage keys', failing.sessionStorage));
  const cookies = failing.cookies ?? [];
  lines.push(
    cookies.length === 0 ? '- Cookies: none' : `- Cookies (${cookies.length}): ${cookies.map(cookieFlags).join(', ')}`,
  );
  if (failing.focus) lines.push(`- Focused element: ${describeFocus(failing.focus)}`);
  if (failing.hover) lines.push(`- Element under the mouse: ${failing.hover.label}`);
  if (failing.selection) lines.push(`- Text selected in the page: ${failing.selection.length} characters`);
  if (failing.indeterminate?.length) {
    lines.push(`- Indeterminate checkboxes: ${failing.indeterminate.map((box) => box.label).join(', ')}`);
  }
  lines.push(
    "- Storage values and cookie values are never captured — key names, lengths and flags only; focus, mouse and selection name elements, never a field's value or the selected text.",
  );

  if (baseline) {
    const diffLines: string[] = [];
    if (failing.url && baseline.url && failing.url !== baseline.url) {
      diffLines.push(`- URL: ${failing.url} ← was ${baseline.url}`);
    }
    const ls = keyDiff(
      (failing.localStorage ?? []).map((e) => e.key),
      (baseline.localStorage ?? []).map((e) => e.key),
    );
    if (ls) diffLines.push(`- localStorage: ${ls}`);
    const ss = keyDiff(
      (failing.sessionStorage ?? []).map((e) => e.key),
      (baseline.sessionStorage ?? []).map((e) => e.key),
    );
    if (ss) diffLines.push(`- sessionStorage: ${ss}`);
    const ck = keyDiff(
      (failing.cookies ?? []).map((c) => c.name),
      (baseline.cookies ?? []).map((c) => c.name),
    );
    if (ck) diffLines.push(`- Cookies: ${ck}`);

    lines.push('', '### Diff vs last pass');
    lines.push(
      diffLines.length > 0
        ? diffLines.join('\n')
        : '- No differences — URL, storage keys and cookies match the last passing run.',
    );
  }

  return lines.join('\n');
}
