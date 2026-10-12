/**
 * What the editor service knows about one file, computed from the project's
 * indexes and the file's text: the locators a test file calls on each line
 * and how stable they are, and, for an application file, the locators its
 * unsaved changes break. Pure: the language server turns these into
 * diagnostics, quick fixes, hovers and summary lines.
 */
import { extractDiffAnchors, type DiffAnchor, type DiffFile, type DiffHunk } from '@piwitests/core/diff-anchors';
import {
  predictLocatorBreaks,
  reachOfIndex,
  sameFilePath,
  callSiteFile,
  callSiteLine,
  type LocatorBreak,
} from '@piwitests/core/locator-break';
import { buildLiteralEdit, buildLocatorEdit } from '@piwitests/core/locator-edit';
import { filePageTarget, pageKeyMatchesTarget } from '@piwitests/core/file-routes';
import { urlMatches, type TestFunctionEntry } from '@piwitests/core/function-match';
import { recommendLocatorFix } from '@piwitests/core/locator-fix';
import type { LocatorIndex, LocatorIndexEntry, LocatorIndexTest, LocatorIndexUse } from '@piwitests/core/locator-index';
import { assessLocatorChain, stabilityLabels, type LocatorStability } from '@piwitests/core/locator-stability';
import {
  LOCATING_METHODS,
  parseLeafLocatorCall,
  renderLocatorChain,
  scanLocatorChain,
  tryParseLocatorChain,
} from '@piwitests/core/locator-chain';
import type { RankedLocator } from '@piwitests/core/locator-healing-types';
import type { CallSiteAlternatives, CodeIndex, FlakeLabEntry } from './piwi-client.js';
import { relativeTo } from './workspace.js';

/** A locator the index knows at one line of a file. */
export interface LineLocator {
  /** 1-based line. */
  line: number;
  entry: LocatorIndexEntry;
  /** The uses whose call site is this line. */
  uses: LocatorIndexUse[];
  tests: LocatorIndexTest[];
  actions: string[];
  stability: LocatorStability | null;
}

/** Every call site of an index, in its order, and the positions of each file's call sites among them. */
interface IndexCallSites {
  sites: Array<{ entry: LocatorIndexEntry; use: LocatorIndexUse; site: string }>;
  byFile: Map<string, number[]>;
}

const callSitesByIndex = new WeakMap<LocatorIndex, IndexCallSites>();

/** The call sites of an index, grouped by file once per index: a request reads the groups of its file alone. */
function callSitesOf(index: LocatorIndex): IndexCallSites {
  let known = callSitesByIndex.get(index);
  if (!known) {
    known = { sites: [], byFile: new Map() };
    for (const entry of index.locators) {
      for (const use of entry.uses) {
        for (const site of use.callSites) {
          const file = callSiteFile(site);
          const at = known.byFile.get(file) ?? known.byFile.set(file, []).get(file)!;
          at.push(known.sites.length);
          known.sites.push({ entry, use, site });
        }
      }
    }
    callSitesByIndex.set(index, known);
  }
  return known;
}

/** Whether the index's tests call locators from a file, by its path relative to the Playwright config. */
export function callsLocatorsFrom(index: LocatorIndex, relativePath: string): boolean {
  for (const file of callSitesOf(index).byFile.keys()) if (sameFilePath(file, relativePath)) return true;
  return false;
}

const stabilityByIndex = new WeakMap<LocatorIndex, Map<string, LocatorStability | null>>();

/** How stable an index's locator is, assessed once per index; null for a chain that does not parse. */
function stabilityOf(index: LocatorIndex, locator: string): LocatorStability | null {
  let known = stabilityByIndex.get(index);
  if (!known) stabilityByIndex.set(index, (known = new Map()));
  if (!known.has(locator)) {
    const chain = tryParseLocatorChain(locator);
    known.set(locator, chain ? assessLocatorChain(chain) : null);
  }
  return known.get(locator)!;
}

/** The tests of a file: those it defines, and those whose steps call locators from it. */
function testsOfFile(index: LocatorIndex, relativePath: string): Set<number> {
  const tests = new Set<number>();
  index.tests.forEach((t, i) => {
    if (sameFilePath(t.file, relativePath)) tests.add(i);
  });
  const { sites, byFile } = callSitesOf(index);
  for (const [file, at] of byFile) {
    if (sameFilePath(file, relativePath)) for (const position of at) tests.add(sites[position]!.use.test);
  }
  return tests;
}

/** The locators the index knows at each line of a file, by its path relative to the Playwright config. */
export function locatorsInFile(index: LocatorIndex, relativePath: string): LineLocator[] {
  const { sites, byFile } = callSitesOf(index);
  // The file's call sites, in the index's order.
  const positions: number[] = [];
  for (const [file, at] of byFile) if (sameFilePath(file, relativePath)) positions.push(...at);
  positions.sort((a, b) => a - b);
  const byKey = new Map<string, LineLocator>();
  for (const position of positions) {
    const { entry, use, site } = sites[position]!;
    const line = callSiteLine(site);
    if (line === null) continue;
    const key = `${line}\u0000${entry.locator}`;
    let found = byKey.get(key);
    if (!found) {
      found = { line, entry, uses: [], tests: [], actions: [], stability: stabilityOf(index, entry.locator) };
      byKey.set(key, found);
    }
    if (!found.uses.includes(use)) {
      found.uses.push(use);
      const test = index.tests[use.test];
      if (test && !found.tests.includes(test)) found.tests.push(test);
      for (const a of use.actions) if (!found.actions.includes(a)) found.actions.push(a);
    }
  }
  return [...byKey.values()].sort((a, b) => a.line - b.line || b.tests.length - a.tests.length);
}

/** The columns of the locator call on a source line: the leaf method's name through its closing parenthesis, else the trimmed line. */
export function locatorRange(lineText: string, locator: string): { start: number; end: number } {
  const leaf = parseLeafLocatorCall(locator);
  if (leaf) {
    const re = new RegExp(`(?<![\\w$])${leaf.method}\\s*\\(`);
    const m = re.exec(lineText);
    if (m) {
      let depth = 0;
      let quote: string | null = null;
      for (let i = m.index + m[0].length - 1; i < lineText.length; i++) {
        const ch = lineText[i]!;
        if (quote) {
          if (ch === '\\') i++;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return { start: m.index, end: i + 1 };
      }
      return { start: m.index, end: lineText.length };
    }
  }
  const start = lineText.length - lineText.trimStart().length;
  return { start, end: lineText.trimEnd().length };
}

/** A stability finding on a locator line, for a diagnostic. */
export interface StabilityFinding {
  line: number;
  locator: string;
  level: 'brittle' | 'watch';
  message: string;
}

/** Brittle (a warning) and watch (a hint) locators of a test file. */
export function stabilityFindings(locators: LineLocator[]): StabilityFinding[] {
  const out: StabilityFinding[] = [];
  for (const l of locators) {
    const level = l.stability?.level;
    if (level !== 'brittle' && level !== 'watch') continue;
    const tests = `${l.tests.length} ${l.tests.length === 1 ? 'test' : 'tests'}`;
    out.push({
      line: l.line,
      locator: l.entry.locator,
      level,
      message: `${level === 'brittle' ? 'Brittle' : 'Worth a look'}: ${stabilityLabels(l.stability!)} · ${tests}`,
    });
  }
  return out;
}

/**
 * The replacement for a brittle locator at a call site: among the
 * alternatives stored the last time it passed, those the stability rules call
 * stable, picked the way locator healing picks. Null when none qualifies.
 */
export function stableReplacement(
  locator: string,
  line: number,
  relativePath: string,
  stored: CallSiteAlternatives[],
): RankedLocator | null {
  const site = stored.find(
    (s) => callSiteLine(s.location) === line && sameFilePath(callSiteFile(s.location), relativePath),
  );
  if (!site) return null;
  const stable = site.alternatives.filter((a) => {
    const chain = tryParseLocatorChain(a.locator);
    return chain && assessLocatorChain(chain).level === 'stable' && a.locator !== locator;
  });
  if (!stable.length) return null;
  const method = parseLeafLocatorCall(locator)?.method;
  return recommendLocatorFix(method, stable)?.recommended ?? null;
}

/**
 * The line with the locator replaced by `replacement`: the whole chain when
 * the line holds it (`page.locator('.row').nth(2).click()` keeps `page.` and
 * `.click()`), else its last locating call. Null when the line holds neither.
 */
export function replaceLocatorOnLine(lineText: string, locator: string, replacement: string): string | null {
  const chain = tryParseLocatorChain(locator);
  const first = chain?.calls[0]?.method;
  if (chain && first) {
    const re = new RegExp(`(?<![\\w$])${first}\\s*\\(`, 'g');
    for (const m of lineText.matchAll(re)) {
      const scanned = scanLocatorChain(lineText.slice(m.index));
      if (scanned && renderLocatorChain(scanned.chain) === renderLocatorChain(chain)) {
        const next = lineText.slice(0, m.index) + replacement + lineText.slice(m.index + scanned.end);
        return next === lineText ? null : next;
      }
    }
  }
  const method = parseLeafLocatorCall(locator)?.method;
  return buildLocatorEdit(lineText, method, replacement)?.new ?? null;
}

/** The start of a locating call on a source line: `getByRole(`, `.locator(`, never `myLocator(`. */
const LOCATING_CALL = new RegExp(`(?<![\\w$])(?:${[...LOCATING_METHODS].join('|')})\\s*\\(`, 'g');

/** The first locator chain a source line holds: its columns and its source; null when it holds none. */
export function locatorChainOnLine(lineText: string): { start: number; end: number; locator: string } | null {
  for (const m of lineText.matchAll(LOCATING_CALL)) {
    const scanned = scanLocatorChain(lineText.slice(m.index));
    if (scanned) return { start: m.index, end: m.index + scanned.end, locator: renderLocatorChain(scanned.chain) };
  }
  return null;
}

/**
 * The edit that puts `picked` in place of the locator chain a source line holds, the chain `replaceLocatorOnLine`
 * replaces (`page.` and the action after it stay), as the columns it replaces and their new text; null when the line
 * holds no locator.
 */
export function pickEditOnLine(
  lineText: string,
  picked: string,
): { start: number; end: number; newText: string } | null {
  const held = locatorChainOnLine(lineText);
  return held ? { start: held.start, end: held.end, newText: picked } : null;
}

/**
 * `PIWI_PAUSE_AT` for the breakpoints (0-based lines) of the files under a Playwright config's folder: each file
 * relative to that folder, with forward slashes, and its 1-based line, separated by semicolons
 * (`tests/login.spec.ts:42;tests/pages/checkout.page.ts:9`). Null when none is under it.
 */
export function pauseAtValue(root: string, breakpoints: Array<{ file: string; line: number }>): string | null {
  const entries = new Set<string>();
  for (const b of breakpoints) {
    if (!Number.isInteger(b.line) || b.line < 0) continue;
    const rel = relativeTo(root, b.file);
    if (rel) entries.add(`${rel}:${b.line + 1}`);
  }
  return entries.size ? [...entries].join(';') : null;
}

/** A Playwright command line that runs headed: `--headed` appended unless it carries `--headed`, `--ui` or `--debug`. */
export function headedCommand(command: string, args: string[]): { command: string; args: string[] } {
  const shows = /(?:^|\s)["']?--(?:headed|ui|debug)(?:[=\s"']|$)/;
  if (shows.test(command) || args.some((a) => /^--(?:headed|ui|debug)(?:=|$)/.test(a))) return { command, args };
  return { command: `${command} --headed`, args: [...args, '--headed'] };
}

/** The first `@piwitests/reporter` that pauses at the editor's breakpoints. */
export const PAUSE_REPORTER_VERSION = '0.48.0';

/**
 * Why breakpoints do nothing with the project's reporter: a sentence when its version (major.minor.patch) is older
 * than `PAUSE_REPORTER_VERSION`; null when it is as new, or unknown.
 */
export function breakpointsNotice(reporterVersion: string | null): string | null {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const have = reporterVersion ? parse(reporterVersion) : null;
  const need = parse(PAUSE_REPORTER_VERSION)!;
  if (!have) return null;
  for (let i = 0; i < 3; i++) {
    if (have[i]! > need[i]!) return null;
    if (have[i]! < need[i]!) {
      return `Breakpoints need @piwitests/reporter ${PAUSE_REPORTER_VERSION} or later; this project has ${reporterVersion!.trim()}.`;
    }
  }
  return null;
}

/** Which files each test reaches, from the code index; undefined when it holds no client reach. Built once per index. */
const reachByIndex = new WeakMap<CodeIndex, ReturnType<typeof reachOfIndex>>();
export function reachFrom(codeIndex: CodeIndex | null): ((testId: number, file: string) => boolean) | undefined {
  if (!codeIndex) return undefined;
  if (!reachByIndex.has(codeIndex)) reachByIndex.set(codeIndex, reachOfIndex(codeIndex));
  return reachByIndex.get(codeIndex);
}

/** The tests of the code index that reach a file (repository-relative). */
export function testsReaching(codeIndex: CodeIndex | null, repoRelativePath: string): LocatorIndexTest[] {
  if (!codeIndex) return [];
  const out = new Map<number, LocatorIndexTest>();
  for (const r of codeIndex.reach) {
    if (!sameFilePath(codeIndex.files[r.file]!, repoRelativePath)) continue;
    for (const t of r.tests) {
      const test = codeIndex.tests[t];
      if (test) out.set(test.id, test);
    }
  }
  return [...out.values()];
}

/** The breaks an application file's unsaved changes cause, from its diff against the committed version. */
export function breaksOfChange(
  diff: DiffFile,
  index: LocatorIndex,
  options: {
    translations?: (key: string, side: 'old' | 'new') => string | undefined;
    readFile?: (path: string, side: 'old' | 'new') => string | undefined;
    reach?: (testId: number, file: string) => boolean;
  } = {},
): LocatorBreak[] {
  const anchors = extractDiffAnchors([diff], {
    testIdAttributes: index.testIdAttributes ?? undefined,
    isTestFile: (file) => /(?:^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file),
    translations: options.translations,
    readFile: options.readFile,
  });
  return predictLocatorBreaks(anchors, index, { reach: options.reach });
}

/** The breaks grouped by the anchor that causes them. */
export function breaksByAnchor(breaks: LocatorBreak[]): Array<{ anchor: DiffAnchor; breaks: LocatorBreak[] }> {
  const groups = new Map<DiffAnchor, LocatorBreak[]>();
  for (const b of breaks) groups.set(b.anchor, [...(groups.get(b.anchor) ?? []), b]);
  return [...groups].map(([anchor, list]) => ({ anchor, breaks: list }));
}

/** One line edit at a call site. */
export interface CallSiteEdit {
  /** The call site's file, relative to the Playwright config. */
  file: string;
  /** 1-based line. */
  line: number;
  oldText: string;
  newText: string;
}

/**
 * The call-site edits that apply a set of breaks' rewrites: each call site
 * whose line holds the old string gets it replaced, keeping its quotes. `lineOf`
 * reads a line of a file (the open buffer or the disk); a call site it cannot
 * read, or whose line does not hold the string, is left out.
 */
export function rewriteEdits(
  breaks: LocatorBreak[],
  lineOf: (file: string, line: number) => string | null,
): CallSiteEdit[] {
  const edits = new Map<string, CallSiteEdit>();
  for (const b of breaks) {
    if (!b.rewrite || !b.replacements?.length) continue;
    for (const use of b.uses) {
      for (const site of use.callSites) {
        const file = callSiteFile(site);
        const line = callSiteLine(site);
        if (line === null) continue;
        const key = `${file}:${line}`;
        const current = edits.get(key)?.newText ?? lineOf(file, line);
        if (current === null) continue;
        let next = current;
        for (const [before, after] of b.replacements) next = buildLiteralEdit(next, before, after)?.new ?? next;
        if (next === current) continue;
        edits.set(key, { file, line, oldText: edits.get(key)?.oldText ?? current, newText: next });
      }
    }
  }
  return [...edits.values()];
}

/** How a break reads in a diagnostic: `3 tests find this by "Pay now": getByRole('button', { name: 'Pay now' })`. */
export function breakMessage(anchor: DiffAnchor, breaks: LocatorBreak[]): string {
  const tests = new Set(breaks.flatMap((b) => b.tests.map((t) => t.id))).size;
  const change = anchor.after !== undefined ? `"${anchor.before}" → "${anchor.after}"` : `"${anchor.before}" removed`;
  const list = breaks
    .slice(0, 3)
    .map((b) => b.locator)
    .join(', ');
  const more = breaks.length > 3 ? ` and ${breaks.length - 3} more` : '';
  return `${tests} ${tests === 1 ? 'test finds' : 'tests find'} an element by "${anchor.before}" (${change}): ${list}${more}`;
}

/** One file of a unified diff, with its hunks' lines as written (` `, `-`, `+` first). */
export interface PatchFile {
  path: string;
  hunks: Array<{ oldStart: number; lines: string[] }>;
}

/** The files of a unified diff; a created or deleted file is left out (`/dev/null`). */
export function parsePatch(diff: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: PatchFile['hunks'][number] | null = null;
  let oldPath: string | null = null;
  // Lines each side of the current hunk still expects, from its header.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('--- ')) {
      oldPath = line.slice(4).trim();
      file = null;
      hunk = null;
    } else if (line.startsWith('+++ ')) {
      const newPath = line.slice(4).trim();
      file = null;
      if (oldPath !== '/dev/null' && newPath !== '/dev/null') {
        file = { path: newPath.replace(/^b\//, '').replace(/\t.*$/, ''), hunks: [] };
        files.push(file);
      }
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      hunk = file && m ? { oldStart: Number(m[1]), lines: [] } : null;
      oldLeft = m ? Number(m[2] ?? 1) : 0;
      newLeft = m ? Number(m[3] ?? 1) : 0;
      if (hunk) file!.hunks.push(hunk);
    } else if (hunk && (oldLeft > 0 || newLeft > 0)) {
      // An empty line is a blank context line whose leading space was stripped.
      const marked = line === '' ? ' ' : line;
      const mark = marked[0];
      if (mark !== ' ' && mark !== '-' && mark !== '+') continue;
      hunk.lines.push(marked);
      if (mark !== '+') oldLeft--;
      if (mark !== '-') newLeft--;
    }
  }
  return files.filter((f) => f.hunks.length > 0);
}

/**
 * The text with a file's hunks applied, as `git apply` would with no fuzz: each
 * hunk's context and removed lines found at its line or the nearest offset
 * (trailing whitespace ignored). Null when a hunk is not found.
 */
export function applyPatchFile(text: string, file: PatchFile): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let delta = 0;
  for (const hunk of file.hunks) {
    const before = hunk.lines.filter((l) => !l.startsWith('+')).map((l) => l.slice(1));
    const after = hunk.lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1));
    const matches = (at: number) =>
      at >= 0 && at + before.length <= lines.length && before.every((l, i) => lines[at + i]!.trimEnd() === l.trimEnd());
    const expected = Math.max(0, hunk.oldStart - 1 + delta);
    let at = -1;
    for (let offset = 0; offset <= lines.length && at < 0; offset++) {
      if (matches(expected - offset)) at = expected - offset;
      else if (matches(expected + offset)) at = expected + offset;
    }
    if (at < 0) return null;
    lines.splice(at, before.length, ...after);
    delta = at - (hunk.oldStart - 1) + after.length - before.length;
  }
  return lines.join(eol);
}

/** A chain offered after `page.`: the suite already uses it on a page this file's tests visit. */
export interface LocatorSuggestion {
  locator: string;
  /** Tests using it. */
  tests: number;
  /** The pages of this file's tests it was used on, as the index names them. */
  pages: string[];
  stability: LocatorStability | null;
}

/** Suggestions offered at most. */
export const MAX_SUGGESTIONS = 50;

/**
 * The chains to offer in a file: those used on the pages this file's tests
 * visit (the tests it defines, or whose steps call locators from it), most used
 * first. Without a known page, the project's most used chains.
 */
export function locatorSuggestions(index: LocatorIndex, relativePath: string): LocatorSuggestion[] {
  const tests = testsOfFile(index, relativePath);
  const pages = new Set<number>();
  for (const entry of index.locators) {
    for (const use of entry.uses) if (tests.has(use.test)) for (const p of use.pages ?? []) pages.add(p);
  }
  const out: LocatorSuggestion[] = [];
  for (const entry of index.locators) {
    const uses = pages.size ? entry.uses.filter((u) => (u.pages ?? []).some((p) => pages.has(p))) : entry.uses;
    if (!uses.length) continue;
    const onPages = [...new Set(uses.flatMap((u) => (u.pages ?? []).filter((p) => pages.has(p))))];
    out.push({
      locator: entry.locator,
      tests: new Set(uses.map((u) => u.test)).size,
      pages: onPages.map((p) => index.pages?.[p]).filter((p): p is string => !!p),
      stability: stabilityOf(index, entry.locator),
    });
  }
  const rank = (s: LocatorSuggestion) =>
    s.stability?.level === 'brittle' ? 2 : s.stability?.level === 'watch' ? 1 : 0;
  return out.sort((a, b) => rank(a) - rank(b) || b.tests - a.tests).slice(0, MAX_SUGGESTIONS);
}

/** What the suite does on the page a page file renders. */
export interface PageSummary {
  /** The index's page keys the file renders. */
  pages: string[];
  tests: LocatorIndexTest[];
  locators: number;
  brittle: number;
}

/**
 * The tests acting on the page a page file renders (Nuxt `pages/**`), its
 * locators and those rated brittle; null when the file is not a page or no test
 * acts on it.
 */
export function pageSummary(index: LocatorIndex, repoRelative: string): PageSummary | null {
  const target = filePageTarget(repoRelative);
  if (!target || !index.pages?.length) return null;
  const pageIds = new Set<number>();
  index.pages.forEach((key, i) => {
    if (pageKeyMatchesTarget(target, key)) pageIds.add(i);
  });
  if (!pageIds.size) return null;
  const tests = new Set<number>();
  let locators = 0;
  let brittle = 0;
  for (const entry of index.locators) {
    const uses = entry.uses.filter((u) => (u.pages ?? []).some((p) => pageIds.has(p)));
    if (!uses.length) continue;
    locators++;
    for (const u of uses) tests.add(u.test);
    if (stabilityOf(index, entry.locator)?.level === 'brittle') brittle++;
  }
  if (!tests.size) return null;
  return {
    pages: [...pageIds].map((i) => index.pages![i]!),
    tests: [...tests].map((i) => index.tests[i]!).filter(Boolean),
    locators,
    brittle,
  };
}

/** A test whose timeout could be tighter (`GET /api/projects/:id/timeout-opportunities`). */
export interface TimeoutAdvice {
  testCaseId: number;
  kind: 'oversized-timeout' | 'stale-slow';
  timeout: number | null;
  p95: number;
  recommendedTimeout: number | null;
  estimatedSavingMs: number;
}

function seconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 100) / 10} s`;
}

/** The sentence a timeout diagnostic shows. */
export function timeoutMessage(advice: TimeoutAdvice): string {
  const saving =
    advice.estimatedSavingMs >= 1000 ? `, about ${seconds(advice.estimatedSavingMs)} less per failing run` : '';
  if (advice.kind === 'stale-slow') {
    return `test.slow() is no longer needed: its p95 is ${seconds(advice.p95)}${advice.timeout ? ` against a ${seconds(advice.timeout)} timeout` : ''}${saving}`;
  }
  return `Timeout ${advice.timeout ? seconds(advice.timeout) : ''} is far above its p95 of ${seconds(advice.p95)}: ${seconds(advice.recommendedTimeout ?? 0)} is enough${saving}`;
}

/**
 * The edit a timeout advice suggests in the body of the test declared at
 * `testLine` (0-based): remove its `test.slow()`, or set its timeout, replacing
 * a `test.setTimeout(…)` there or adding one as the body's first statement.
 * Null when the body cannot be told apart.
 */
export function timeoutEdit(
  lines: string[],
  testLine: number,
  advice: TimeoutAdvice,
): { line: number; replace: boolean; text: string } | null {
  let end = lines.length;
  for (let i = testLine + 1; i < lines.length; i++) {
    if (/(?<![\w$.])test(?:\.(?:only|skip|fixme|fail|slow))?\s*\(\s*['"`]/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const body = lines.slice(testLine + 1, end);
  if (advice.kind === 'stale-slow') {
    const at = body.findIndex((l) => /^\s*test\.slow\(\s*\)\s*;?\s*$/.test(l));
    return at < 0 ? null : { line: testLine + 1 + at, replace: true, text: '' };
  }
  if (!advice.recommendedTimeout) return null;
  const at = body.findIndex((l) => /^\s*test\.setTimeout\(\s*[\d_]+\s*\)\s*;?\s*$/.test(l));
  if (at >= 0) {
    const current = body[at]!;
    return {
      line: testLine + 1 + at,
      replace: true,
      text: current.replace(/\(\s*[\d_]+\s*\)/, `(${advice.recommendedTimeout})`),
    };
  }
  const first = body.find((l) => l.trim());
  if (!first || !/\{\s*$/.test(lines[testLine]!)) return null;
  const indent = first.slice(0, first.length - first.trimStart().length);
  return { line: testLine + 1, replace: false, text: `${indent}test.setTimeout(${advice.recommendedTimeout});` };
}

/** The page keys this file's tests visit: the tests it defines, or whose steps call locators from it. */
export function filePages(index: LocatorIndex, relativePath: string): string[] {
  const tests = testsOfFile(index, relativePath);
  const pages = new Set<number>();
  for (const entry of index.locators) {
    for (const use of entry.uses) if (tests.has(use.test)) for (const p of use.pages ?? []) pages.add(p);
  }
  return [...pages].map((p) => index.pages?.[p]).filter((p): p is string => !!p);
}

/**
 * The catalog's functions to offer in a file: those whose URL pattern matches a
 * page this file's tests visit, or that name no pattern. With no known page,
 * every function.
 */
export function functionSuggestions(catalog: TestFunctionEntry[], pages: string[]): TestFunctionEntry[] {
  const matching = catalog.filter(
    (f) => !f.urlPattern || !pages.length || pages.some((p) => urlMatches(f.urlPattern, p)),
  );
  return matching.sort((a, b) => Number(!a.urlPattern) - Number(!b.urlPattern) || a.name.localeCompare(b.name));
}

/** A function call as a snippet: the receiver for a page-object method, a placeholder per parameter. */
export function functionSnippet(entry: TestFunctionEntry): string {
  const args = entry.params.map((p, i) => `\${${i + 1}:${p.name.replace(/[$}\\]/g, '')}}`).join(', ');
  const callee = entry.kind === 'page-object-method' && entry.receiver ? `${entry.receiver}.${entry.name}` : entry.name;
  return `await ${callee}(${args})`;
}

/**
 * The 0-based line where the call whose `(` is at `line`/`column` ends: brackets are
 * matched, skipping strings, template literals and comments. Null when it does not end
 * within `maxLines` lines.
 */
export function callEndLine(lines: string[], line: number, column: number, maxLines = 2000): number | null {
  // Open brackets, `` ` `` for a template literal, `$` for an expression inside one.
  const stack: string[] = [];
  let blockComment = false;
  for (let l = line; l < Math.min(lines.length, line + maxLines); l++) {
    const text = lines[l]!;
    let i = l === line ? column : 0;
    while (i < text.length) {
      const c = text[i]!;
      const top = stack[stack.length - 1];
      if (blockComment) {
        if (c === '*' && text[i + 1] === '/') {
          blockComment = false;
          i++;
        }
      } else if (top === '`') {
        if (c === '\\') i++;
        else if (c === '`') stack.pop();
        else if (c === '$' && text[i + 1] === '{') {
          stack.push('$');
          i++;
        }
      } else if (c === '/' && text[i + 1] === '/') {
        break;
      } else if (c === '/' && text[i + 1] === '*') {
        blockComment = true;
        i++;
      } else if (c === "'" || c === '"') {
        i++;
        while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      } else if (c === '`') {
        stack.push('`');
      } else if (c === '(' || c === '[' || c === '{') {
        stack.push(c);
      } else if (c === ')' || c === ']' || c === '}') {
        stack.pop();
        if (!stack.length) return l;
      }
      i++;
    }
  }
  return null;
}

/**
 * Where a line of a failure stands in its file as edited since the run: `same` and `moved` hold its text (on its own
 * line or on another), `edited` changed it, `gone` took its test out of the file.
 */
export type LineState = 'same' | 'moved' | 'edited' | 'gone';

/**
 * Where a line (1-based) of `before` is in `after`, through the hunks of `diffLines(path, before, after)`. A line
 * outside every hunk shifts by the net size of the hunks above it: `same` when its number holds, `moved` when it
 * changes. A line a hunk removed is `moved` to the line of that hunk's added block that holds its text (whitespace
 * trimmed), the nearest to where it stood when several do; with none, it is `edited`, on the hunk's first added line,
 * or on the line before the hunk when the hunk only removes. The hunks never make a line `gone`: whether its test is
 * still in the file is read from the file's text.
 */
export function placeLine(line: number, hunks: DiffHunk[]): { line: number; state: LineState } {
  let shift = 0;
  for (const hunk of hunks) {
    if (!hunk.removed.length) {
      // Lines inserted after `oldStart`.
      if (line <= hunk.oldStart) break;
      shift += hunk.added.length;
      continue;
    }
    const first = hunk.removed[0]!.line;
    const last = hunk.removed[hunk.removed.length - 1]!.line;
    if (line < first) break;
    if (line > last) {
      shift += hunk.added.length - hunk.removed.length;
      continue;
    }
    const text = hunk.removed[line - first]?.text.trim() ?? '';
    const kept = text ? hunk.added.filter((a) => a.text.trim() === text) : [];
    if (kept.length) {
      const near = hunk.newStart + (line - first);
      const nearest = kept.reduce((best, a) => (Math.abs(a.line - near) < Math.abs(best.line - near) ? a : best));
      return { line: nearest.line, state: 'moved' };
    }
    return { line: hunk.added[0]?.line ?? Math.max(1, hunk.newStart), state: 'edited' };
  }
  return { line: line + shift, state: shift ? 'moved' : 'same' };
}

/** The Flake Lab states whose next step verifies a fix. */
const FLAKE_VERIFY_STATES = new Set(['reproduced', 'still-fails', 'inconclusive']);

/** The Flake Lab lens of a flaky test: what it says, and the commands it offers. */
export interface FlakeLabLens {
  /** `flaky 18% · top suspect: GET /api/cart slower (reproduced 7 of 10)`. */
  title: string;
  /** Reproduce it, then verify its fix once a condition reproduced it; each a `piwi flake` command. */
  actions: Array<{ kind: 'reproduce' | 'verify'; title: string; command: string }>;
}

/**
 * The lens above a flaky test: its flaky rate and the suspect it is shown with,
 * then "Reproduce this flake", and "Verify the flake fix" once the lab
 * reproduced it. The verify command is the instance's next command; null when
 * the test is off the flaky ranking with nothing to verify, or its fix holds.
 */
export function flakeLabLens(testCaseId: number, entry: FlakeLabEntry): FlakeLabLens | null {
  const verify = FLAKE_VERIFY_STATES.has(entry.state) && entry.nextCommand?.includes(' verify ');
  if (!entry.nextCommand || (!entry.flaky && !verify)) return null;
  const rate = entry.flakeRate != null ? `flaky ${Math.max(1, Math.round(entry.flakeRate * 100))}%` : 'flaky';
  const suspect = entry.suspect
    ? `top suspect: ${entry.suspect.label} (${entry.suspect.lab})`
    : entry.reproducedBy
      ? `reproduced by ${entry.reproducedBy}`
      : null;
  const reproduce = verify ? `npx @piwitests/reporter flake ${testCaseId}` : entry.nextCommand;
  return {
    title: [rate, suspect].filter(Boolean).join(' · '),
    actions: [
      { kind: 'reproduce', title: 'Reproduce this flake', command: reproduce },
      ...(verify ? [{ kind: 'verify' as const, title: 'Verify the flake fix', command: entry.nextCommand }] : []),
    ],
  };
}
