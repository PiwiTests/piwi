/**
 * CSS rule coverage, resolved: the style sheets a test's pages added, with the
 * rules that matched an element (`coverage.css: 'rules'`), turned into
 * repository-relative files and line ranges. A sheet resolves to a file in one
 * of three ways:
 *
 * - **a source map**, named in its text (`/*# sourceMappingURL=… *\/`) or by its
 *   header: its rules count in the map's sources (a Sass file, a `.vue` file's
 *   `<style>` with Vite's `css.devSourcemap`);
 * - **its owner's `data-vite-dev-id`**: the file a Vite dev server injected it
 *   from, its lines kept, offset by the block's place for a `.vue` file's
 *   `<style>`;
 * - **the address it was served from** (`/assets/app.css`), resolved against
 *   the code reach roots like a module served by path.
 *
 * Files under `node_modules` and build output count for nothing (Tailwind's
 * utilities map into its own package). A sheet's every rule, matched or not,
 * is listed as the file's known rules. Never throws.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { LineRange } from '@piwitests/core/coverage';
import { allCssRules, cssRuleLines, parseCssRules, usedCssRules, type CssRule } from '@piwitests/core/css-rules';
import { decodeDataUrl, decodeSourceMap, sourceMappingUrl, type SourceMapLookup } from '@piwitests/core/source-map';
import {
  relativeToRepo,
  resolveSourcePath,
  scriptRoots,
  type CapturedSheet,
  type CodeReachRoots,
  type MapFetcher,
} from './code-reach.js';

/** The files a style sheet can come from. */
const STYLE_SOURCES = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss|vue|svelte|astro|html?)$/i;

/**
 * Directories a served file is build output in. Unlike scripts, a style sheet under `public/`, `static/` or
 * `wwwroot/` is usually written by hand (`wwwroot/css/site.css`), so those count.
 */
const BUILD_DIRS = /(?:^|\/)(?:dist|build|out|\.output|\.next|\.nuxt|\.svelte-kit)\//;

/** What the style sheets of a test resolve to: per file, the matched rules, and every rule the sheets declare. */
export interface ResolvedRules {
  reached: Map<string, LineRange[]>;
  known: Map<string, LineRange[]>;
}

/** One sheet's text, parsed, and how its lines map to files: cached per worker by text. */
interface SheetResolution {
  rules: CssRule[];
  lookup: SourceMapLookup | null;
  /** Without a map, the sheet's own file and where its text starts in it; with one, the file of each source. */
  file: string | null;
  lineOffset: number;
  sources: Array<string | null>;
}

const resolutions = new Map<string, Promise<SheetResolution | null>>();
/** Sheet versions kept per worker at most, the oldest dropped first. */
const MAX_CACHED_SHEETS = 2000;

/** The file a sheet's address names, when it exists and is not a dependency or build output. */
function fileForStyleUrl(url: string, roots: string[]): string | null {
  let pathname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') return null;
    pathname = parsed.pathname;
  } catch {
    return null;
  }
  return sourceFile(decodeURIComponent(pathname), roots);
}

/** An existing style source a path names, absolute: not a dependency, not build output. */
function sourceFile(source: string, roots: string[]): string | null {
  const bare = source.replace(/[?#].*$/, '');
  if (!STYLE_SOURCES.test(bare) || /(?:^|\/)node_modules\//.test(bare)) return null;
  const file = resolveSourcePath(bare, roots);
  if (!file || BUILD_DIRS.test(file.replace(/\\/g, '/')) || /(?:^|[\\/])node_modules[\\/]/.test(file)) return null;
  return file;
}

/** The 0-based line the `index`-th `<style>` block's content starts on in a component file; 0 when not found. */
function styleBlockLine(file: string, index: number): number {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return 0;
  }
  const blocks = [...text.matchAll(/<style\b[^>]*>/gi)];
  const block = blocks[index];
  if (!block) return 0;
  return text.slice(0, block.index! + block[0].length).split('\n').length - 1;
}

async function sheetMap(sheet: CapturedSheet, text: string, fetchMap: MapFetcher): Promise<SourceMapLookup | null> {
  const ref = sourceMappingUrl(text) ?? sheet.sourceMapURL ?? null;
  if (!ref) return null;
  let raw: string | null;
  if (ref.startsWith('data:')) raw = decodeDataUrl(ref);
  else {
    try {
      raw = await fetchMap(new URL(ref, sheet.sourceURL).href);
    } catch {
      raw = null;
    }
  }
  if (!raw) return null;
  try {
    return decodeSourceMap(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function resolveSheet(
  sheet: CapturedSheet,
  text: string,
  dirs: string[],
  fetchMap: MapFetcher,
): Promise<SheetResolution | null> {
  const lookup = await sheetMap(sheet, text, fetchMap);
  const rules = parseCssRules(text);
  if (lookup) {
    const sources = lookup.sources.map((source) => {
      const direct = sourceFile(source, dirs);
      if (direct) return direct;
      try {
        return /^[a-z][\w+.-]*:/i.test(source) ? null : fileForStyleUrl(new URL(source, sheet.sourceURL).href, dirs);
      } catch {
        return null;
      }
    });
    return { rules, lookup, file: null, lineOffset: 0, sources };
  }
  if (sheet.devId) {
    const file = sourceFile(sheet.devId, dirs);
    if (!file) return null;
    // A component's `<style>` block, served alone: its lines start where the block does in the file.
    const index = /[?&]index=(\d+)/.exec(sheet.devId);
    const lineOffset = /\.(?:vue|svelte|astro)$/i.test(file) && index ? styleBlockLine(file, Number(index[1])) : 0;
    return { rules, lookup: null, file, lineOffset, sources: [] };
  }
  const file = fileForStyleUrl(sheet.sourceURL, dirs);
  if (!file) return null;
  return { rules, lookup: null, file, lineOffset: sheet.isInline ? sheet.startLine : 0, sources: [] };
}

/** Resolve a sheet, once per worker for a given address and text. */
function cachedResolution(
  sheet: CapturedSheet,
  text: string,
  dirs: string[],
  fetchMap: MapFetcher,
): Promise<SheetResolution | null> {
  const key = `${sheet.devId ?? sheet.sourceURL} ${crypto.createHash('sha1').update(text).digest('hex')}`;
  let pending = resolutions.get(key);
  if (!pending) {
    pending = resolveSheet(sheet, text, dirs, fetchMap).catch(() => null);
    resolutions.set(key, pending);
    if (resolutions.size > MAX_CACHED_SHEETS) resolutions.delete(resolutions.keys().next().value!);
  }
  return pending;
}

function add(into: Map<string, LineRange[]>, file: string, ranges: LineRange[], repoRoot: string): void {
  if (ranges.length === 0) return;
  const key = relativeToRepo(file, repoRoot);
  into.set(key, [...(into.get(key) ?? []), ...ranges]);
}

/** The files the sheets resolve to, with their matched rules and every rule they declare. */
export async function resolveCssCoverage(
  sheets: readonly CapturedSheet[],
  roots: CodeReachRoots,
  fetchMap: MapFetcher,
): Promise<ResolvedRules> {
  const reached = new Map<string, LineRange[]>();
  const known = new Map<string, LineRange[]>();
  for (const sheet of sheets) {
    if (sheet.text === undefined) continue;
    const dirs = scriptRoots(roots, sheet.sourceURL, sheet.pageUrl);
    const resolution = await cachedResolution(sheet, sheet.text, dirs, fetchMap);
    if (!resolution) continue;
    const options = { lookup: resolution.lookup, lineOffset: resolution.lineOffset };
    const fileOf = (source: number) => (source === -1 ? resolution.file : (resolution.sources[source] ?? null));
    const matched = cssRuleLines(sheet.text, usedCssRules(resolution.rules, [...sheet.used.values()]), options);
    for (const [source, ranges] of matched) {
      const file = fileOf(source);
      if (file) add(reached, file, ranges, roots.repoRoot);
    }
    for (const [source, ranges] of cssRuleLines(sheet.text, allCssRules(resolution.rules), options)) {
      const file = fileOf(source);
      if (file) add(known, file, ranges, roots.repoRoot);
    }
  }
  return { reached, known };
}

/** Forget the per-worker cache (tests only). */
export function resetCssCoverageCache(): void {
  resolutions.clear();
}
