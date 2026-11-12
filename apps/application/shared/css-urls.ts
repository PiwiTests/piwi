/**
 * The `url(...)` references and `@import` rules of a CSS text, found in time linear in its length whatever it holds,
 * for the snapshot views that inline a page's assets (`server/utils/dom-snapshot-render.ts`) and strip what would
 * fetch (`snapshot-picker-document.ts`). Each reads what a pattern would, but a pattern tried at each `url(` of a text
 * that never closes one scans to its end each time: a few hundred thousand characters would take minutes. Here each
 * search for what ends a reference starts where the last one ended, its answer kept while it still holds.
 */

/** A `url(...)` of a CSS text: where it starts and ends, and its target as written, quoted or bare. */
export interface CssUrl {
  start: number;
  end: number;
  target: string;
}

/** A span of a CSS text: where it starts and ends. */
export interface CssSpan {
  start: number;
  end: number;
}

/**
 * The next place at or after a position where `pattern` (global) matches, `text.length` for none, for positions that
 * never go back: an answer found is kept while the position stays at or before it.
 */
function seeker(text: string, pattern: RegExp): (from: number) => number {
  let asked = Number.POSITIVE_INFINITY;
  let found = -1;
  return (from) => {
    if (from >= asked && from <= found) return found;
    pattern.lastIndex = from;
    const match = pattern.exec(text);
    asked = from;
    found = match ? match.index : text.length;
    return found;
  };
}

/** The places, in order, where `pattern` (global) matches `text`, and where each match ends. */
function places(text: string, pattern: RegExp): { at: number[]; ends: number[] } {
  const at: number[] = [];
  const ends: number[] = [];
  for (const match of text.matchAll(pattern)) {
    at.push(match.index);
    ends.push(match.index + match[0].length);
  }
  return { at, ends };
}

/** The first of `list` (in order) after `position`, from `index` on: its index in the list, which never goes back. */
function firstAfter(list: number[], index: number, position: number): number {
  let i = index;
  while (i < list.length && list[i]! <= position) i++;
  return i;
}

const LINE_END = /[\n\r\u2028\u2029]/g;

/**
 * Every `url(...)` of `css`, in order, as `url\(\s*(?:(['"])(.*?)\1|([^)\s'"]+))\s*\)` reads them (case aside): a
 * quoted target runs to the first same quote that `)` follows, past none of the text's line ends; a bare one runs to
 * the first `)`, quote or space, which `)` must follow, spaces aside.
 */
export function cssUrls(css: string): CssUrl[] {
  const urls: CssUrl[] = [];
  // Each quote a `)` follows, spaces aside, by quote: where a quoted target may end, and where its reference does.
  const closers = { '"': places(css, /"\s*\)/g), "'": places(css, /'\s*\)/g) };
  const next = { '"': 0, "'": 0 };
  const lineEnds = places(css, LINE_END).at;
  let lineEnd = 0;
  const spaceAfterOpen = seeker(css, /\S/g);
  const bareEnd = seeker(css, /[)\s'"]/g);
  const spaceAfterTarget = seeker(css, /\S/g);
  const opens = /url\(/gi;
  let from = 0;
  for (;;) {
    opens.lastIndex = from;
    const open = opens.exec(css);
    if (!open) break;
    const start = open.index;
    const at = spaceAfterOpen(start + 4);
    const quote = css[at];
    if (quote === '"' || quote === "'") {
      const ends = closers[quote];
      next[quote] = firstAfter(ends.at, next[quote], at);
      lineEnd = firstAfter(lineEnds, lineEnd, at);
      const close = ends.at[next[quote]];
      if (close !== undefined && close < (lineEnds[lineEnd] ?? Number.POSITIVE_INFINITY)) {
        const end = ends.ends[next[quote]]!;
        urls.push({ start, end, target: css.slice(at + 1, close) });
        from = end;
        continue;
      }
    } else {
      const stop = bareEnd(at);
      const after = stop > at ? spaceAfterTarget(stop) : -1;
      if (after >= 0 && css[after] === ')') {
        urls.push({ start, end: after + 1, target: css.slice(at, stop) });
        from = after + 1;
        continue;
      }
    }
    from = start + 1;
  }
  return urls;
}

/** `css` with each `url(...)` that `replace` names a replacement for written as it says; the rest as it was. */
export function replaceCssUrls(css: string, replace: (url: CssUrl) => string | null): string {
  let out = '';
  let last = 0;
  for (const url of cssUrls(css)) {
    const replacement = replace(url);
    if (replacement === null) continue;
    out += css.slice(last, url.start) + replacement;
    last = url.end;
  }
  return last === 0 ? css : out + css.slice(last);
}

/**
 * Every `@import` rule of `css`, in order, as
 * `@import\s+(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)|"[^"]*"|'[^']*')[^;]*;?` reads them (case aside): its address
 * quoted or in a `url(...)`, then the rest of the rule up to its `;`, that included.
 */
export function cssImports(css: string): CssSpan[] {
  const spans: CssSpan[] = [];
  const space = seeker(css, /\S/g);
  const quotes = { '"': seeker(css, /"/g), "'": seeker(css, /'/g) };
  const closeParen = seeker(css, /\)/g);
  const semicolon = seeker(css, /;/g);
  const imports = /@import/gi;
  let from = 0;
  for (;;) {
    imports.lastIndex = from;
    const found = imports.exec(css);
    if (!found) break;
    const start = found.index;
    const at = space(start + 7);
    let address = -1;
    if (at > start + 7 && at < css.length) {
      if (/^url\(/i.test(css.slice(at, at + 4))) {
        const inner = space(at + 4);
        const quote = css[inner];
        if (quote === '"' || quote === "'") {
          const close = quotes[quote](inner + 1);
          if (close < css.length && css[close + 1] === ')') address = close + 2;
        }
        if (address < 0) {
          const paren = closeParen(at + 4);
          if (paren < css.length) address = paren + 1;
        }
      } else if (css[at] === '"' || css[at] === "'") {
        const close = quotes[css[at] as '"' | "'"](at + 1);
        if (close < css.length) address = close + 1;
      }
    }
    if (address < 0) {
      from = start + 1;
      continue;
    }
    const stop = semicolon(address);
    const end = stop < css.length ? stop + 1 : css.length;
    spans.push({ start, end });
    from = end;
  }
  return spans;
}
