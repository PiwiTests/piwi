/**
 * CSS rule coverage: which rules of a style sheet matched an element during a
 * test, from Chromium's rule usage (`CSS.takeCoverageDelta`), as line ranges.
 * A rule is to a style sheet what a function is to a script, so a matched
 * rule's first and last line go where a function's would.
 *
 * - **A style rule** (`.a, .b { … }`, nested ones included) counts from its
 *   selector to its closing brace.
 * - **A grouping rule** (`@media`, `@supports`, `@layer`, `@container`,
 *   `@scope`, `@starting-style`, `@document`) counts its first line only:
 *   Chromium reports a matching one as an entry spanning its condition, or
 *   for `@layer` its whole block, while the rules inside count on their own.
 * - **Any other at-rule** (`@font-face`, `@keyframes` and its frames, `@page`,
 *   `@property`) matches no element and counts for nothing.
 *
 * Chromium lists only the rules that matched; every rule of a sheet, matched
 * or not, comes from parsing its text here. The reporter reads the rule usage
 * and the sheets' text over a CDP session; this module holds the pure part.
 */
import type { LineRange } from './coverage';
import { lineStarts, offsetToPosition, type SourceMapLookup } from './source-map';

/** One rule of a style sheet, by offsets in its text: its start, its opening brace, and the end of its block. */
export interface CssRule {
  kind: 'style' | 'group';
  start: number;
  open: number;
  end: number;
}

/** One entry of Chromium's rule usage: offsets in the sheet's text. */
export interface CssUsedRange {
  startOffset: number;
  endOffset: number;
}

/** The at-rules whose block holds rules that match elements. */
const GROUPING = new Set(['media', 'supports', 'layer', 'container', 'scope', 'starting-style', 'document']);

/** The rules of a style sheet, in source order: style rules and grouping rules, other at-rules left out. */
export function parseCssRules(text: string): CssRule[] {
  const rules: CssRule[] = [];
  const open: Array<{ kind: CssRule['kind'] | 'other'; start: number; open: number }> = [];
  let preludeStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      if (preludeStart < 0) preludeStart = i;
      for (i++; i < text.length && text[i] !== c && text[i] !== '\n'; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '\\') {
      if (preludeStart < 0) preludeStart = i;
      i++;
      continue;
    }
    if (c === '{') {
      const start = preludeStart < 0 ? i : preludeStart;
      const atRule = /^@([\w-]+)/.exec(text.slice(start, i));
      const parent = open[open.length - 1];
      const kind = atRule
        ? GROUPING.has(atRule[1]!.toLowerCase())
          ? 'group'
          : 'other'
        : parent?.kind === 'other'
          ? 'other'
          : 'style';
      open.push({ kind, start, open: i });
      preludeStart = -1;
      continue;
    }
    if (c === '}') {
      const block = open.pop();
      if (block && block.kind !== 'other')
        rules.push({ kind: block.kind, start: block.start, open: block.open, end: i + 1 });
      preludeStart = -1;
      continue;
    }
    if (c === ';') {
      preludeStart = -1;
      continue;
    }
    if (preludeStart < 0 && !/\s/.test(c)) preludeStart = i;
  }
  return rules.sort((a, b) => a.start - b.start);
}

/**
 * The rules the used ranges name, as offsets: a style rule from its selector
 * to its closing brace, a grouping rule at its start only. A range that names
 * no parsed rule is left out.
 */
export function usedCssRules(rules: readonly CssRule[], used: readonly CssUsedRange[]): Array<[number, number]> {
  const styleAt = new Map<number, CssRule>();
  const groups: CssRule[] = [];
  for (const rule of rules) {
    if (rule.kind === 'style') styleAt.set(rule.start, rule);
    else groups.push(rule);
  }
  const out = new Map<string, [number, number]>();
  for (const range of used) {
    const style = styleAt.get(range.startOffset);
    if (style) {
      out.set(`${style.start}`, [style.start, style.end]);
      continue;
    }
    // A grouping rule's entry starts within its prelude: after `@media `, or at a layer's name.
    const group = groups.find((rule) => rule.start <= range.startOffset && range.startOffset <= rule.open);
    if (group) out.set(`${group.start}`, [group.start, group.start + 1]);
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

/** Every rule of a sheet as offsets, as `usedCssRules` gives the matched ones. */
export function allCssRules(rules: readonly CssRule[]): Array<[number, number]> {
  return rules.map((rule) => (rule.kind === 'style' ? [rule.start, rule.end] : [rule.start, rule.start + 1]));
}

/** Where a sheet's text sits, and how its lines map to files. */
export interface CssLineOptions {
  /** The sheet's source map, when it has one: lines then belong to the map's sources. */
  lookup?: SourceMapLookup | null;
  /** The 0-based line of the sheet's text in the file that holds it: a `<style>` element's in its page. */
  lineOffset?: number;
}

/**
 * Rules given as offsets, as 1-based line ranges per file: the map's source
 * index, or -1 for the sheet's own file when it has no map. A rule whose
 * start maps to no source is left out; a rule whose end maps elsewhere ends on
 * its first line.
 */
export function cssRuleLines(
  text: string,
  offsets: ReadonlyArray<readonly [number, number]>,
  options: CssLineOptions = {},
): Map<number, LineRange[]> {
  const starts = lineStarts(text);
  const lineOffset = options.lineOffset ?? 0;
  const out = new Map<number, LineRange[]>();
  const add = (source: number, range: LineRange) => {
    const ranges = out.get(source);
    if (ranges) ranges.push(range);
    else out.set(source, [range]);
  };
  for (const [startOffset, endOffset] of offsets) {
    const start = offsetToPosition(starts, startOffset);
    const end = offsetToPosition(starts, Math.max(startOffset, endOffset - 1));
    if (!options.lookup) {
      add(-1, [start.line + lineOffset + 1, end.line + lineOffset + 1]);
      continue;
    }
    const first = options.lookup.originalAt(start.line, start.column);
    if (!first) continue;
    const last = options.lookup.originalAt(end.line, end.column);
    const lastLine = last && last.source === first.source && last.line >= first.line ? last.line : first.line;
    add(first.source, [first.line + 1, lastLine + 1]);
  }
  return out;
}
