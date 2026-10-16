/**
 * Code reach: the application source files whose functions ran during a test,
 * from V8's function coverage, read through a CDP session on the page.
 * Opt-in (`captureCodeReach`), Chromium-only; other browsers record nothing.
 *
 * The session keeps the debugger on for the test, every pause released at once, to
 * learn each parsed script's URL and V8 content hash, and reads a script's
 * source as soon as it is parsed, only for a version (URL and hash) the worker
 * has not resolved yet: a script seen in an earlier test is never read again.
 * Chromium reports no coverage for a document the page's main frame has left,
 * so the coverage is also read as each document is left: the debugger stops on
 * its `beforeunload`, from a listener the capture adds in an isolated world, and
 * the reads add up: a test that navigates reaches the files of every document it
 * went through. An iframe's earlier documents stay covered, their sources read
 * before they go.
 *
 * Each covered script is resolved to original files in one of two ways:
 *
 * - a module served by path (Vite's `/src/components/Pay.vue`, `/@fs/<abs>`):
 *   the URL's path, tried against the code reach roots, when the file exists;
 *   the roots of the script's origin, or of its page's, come first.
 *   A Vite dev server's `base` (Nuxt's `/_nuxt/`), read from the address its
 *   `@vite/client` script loads from, is dropped from the path first.
 *   When the module has a source map (Vite serves one inline), only functions
 *   that map to its source count, not the hot-reload code the server adds;
 * - a bundle with a source map: the map named by the script's
 *   `sourceMappingURL` comment (inline, or fetched once per worker through the
 *   page's request context, 20 MB and 5 s at most), whose sources resolve
 *   against the roots.
 *
 * A file counts when a function starting in it ran, not counting a script's
 * top-level code. Paths go out relative to the repository root; files outside
 * it and under `node_modules` are dropped, and so are the scripts React
 * evaluates in development to replay server component stacks
 * (`about://React/Server/…`), which stand for code that ran on the server. Decoded maps, resolved paths and the
 * length and line starts of the scripts they are read against are cached per worker by script URL, for the latest
 * version seen at that URL only, and for at most `MAX_CACHED_SCRIPTS` URLs, the least recently used going first.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CDPSession, Page } from '@playwright/test';
import {
  finalizeCodeReach,
  reachedFunctionLines,
  scriptRan,
  scriptText,
  type JsCoverageEntry,
  type ScriptText,
} from '@piwitests/core/code-reach';
import type { LineRange } from '@piwitests/core/coverage';
import {
  decodeDataUrl,
  decodeSourceMap,
  normalizeSourcePath,
  sourceMappingUrl,
  type SourceMapLookup,
} from '@piwitests/core/source-map';
import { internalCall } from './quiet-capture.js';

/** Largest source map fetched, in bytes. */
const MAX_MAP_BYTES = 20 * 1024 * 1024;
const MAP_TIMEOUT_MS = 5000;
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|marko|html?)$/i;
/** Script URLs that stand for code run elsewhere: React's replayed server component stacks. */
const REPLAYED_SCRIPT = /^(?:about|rsc):/i;
/** Script URLs whose code counts for no file: dependencies and a Vite dev server's own client. */
const NEVER_REACHED = /\/node_modules\/|\/@vite\//;
/** Directories a served file is build output in, not source: a bundle there is resolved through its map. */
const BUILD_DIRS = /(?:^|\/)(?:dist|build|out|\.output|\.next|\.nuxt|\.svelte-kit|public|static|wwwroot)\//;

/** Where code reach resolves paths. */
export interface CodeReachRoots {
  /** Directories a module path or a map source is tried against, first match wins; the repository root is last. */
  roots: string[];
  /**
   * Directories tried before `roots` for the scripts an origin serves, or, when the script's own origin has none,
   * that a page at the origin loads: an application served by several dev servers (one per portal) resolves each
   * one's modules against its own directory.
   */
  byOrigin?: Map<string, string[]>;
  /** Paths go out relative to it. */
  repoRoot: string;
}

/** The `codeReachRoots` option: directories for every script, or directories per origin, `*` for the rest. */
export type CodeReachRootsOption = string[] | Record<string, string | string[]>;

/** Fetches a source map's text; null when it cannot. */
export type MapFetcher = (url: string) => Promise<string | null>;

/**
 * One covered script: its function coverage (one range per function), V8's
 * content hash, and its source, which is left out when the worker has already
 * resolved that version of the script.
 */
export interface CoveredScript extends JsCoverageEntry {
  /** V8's content hash of the script; without it, the version is a hash of `source`. */
  hash?: string;
}

/**
 * What one script resolves to, cached per worker with the text its function offsets are read against (its length
 * and line starts, not the source itself).
 */
type ScriptResolution =
  | { kind: 'file'; file: string | null; lookup: SourceMapLookup | null; text: ScriptText | undefined }
  | { kind: 'map'; lookup: SourceMapLookup; files: Array<string | null | undefined>; text: ScriptText | undefined }
  | { kind: 'none' };

/**
 * Script and map URLs cached per worker at most: more than the modules a large application's dev server serves to
 * one page, so a test that navigates between its pages finds every script it has already resolved.
 */
export const MAX_CACHED_SCRIPTS = 4000;

/**
 * A per-worker cache holding, for each URL, the value of the latest version
 * (content hash) seen there only, and at most `MAX_CACHED_SCRIPTS` URLs: a dev
 * server that rebuilds between tests replaces its entries instead of adding.
 */
class LatestByUrl<T> {
  private readonly entries = new Map<string, { version: string; value: T }>();

  get(url: string, version: string): T | undefined {
    const entry = this.entries.get(url);
    if (!entry || entry.version !== version) return undefined;
    this.entries.delete(url);
    this.entries.set(url, entry);
    return entry.value;
  }

  set(url: string, version: string, value: T): void {
    this.entries.delete(url);
    this.entries.set(url, { version, value });
    if (this.entries.size > MAX_CACHED_SCRIPTS) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }
}

const scriptCache = new LatestByUrl<ScriptResolution>();
const mapCache = new LatestByUrl<Promise<SourceMapLookup | null>>();
let cachedRepoRoot: { from: string; root: string } | null = null;

/** The repository root above `from` (`git rev-parse --show-toplevel`, once per worker); `from` when not in a repository. */
export function repositoryRoot(from: string): string {
  if (cachedRepoRoot?.from === from) return cachedRepoRoot.root;
  let root = from;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: from,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a git checkout: paths are relative to `from`.
  }
  cachedRepoRoot = { from, root: path.resolve(root) };
  return cachedRepoRoot.root;
}

/**
 * The roots for a test: `codeReachRoots` when set (an array, or the `*` entry of
 * an object), else the Playwright config's directory; the repository root always
 * comes last, since bundlers name sources from the project root (Turbopack's
 * `[project]/`). An object's other keys are origins, each with the directories
 * tried first for its scripts. Relative directories resolve against the config's.
 */
export function codeReachRoots(configDir: string, configured: CodeReachRootsOption | null | undefined): CodeReachRoots {
  const repoRoot = repositoryRoot(configDir);
  const resolve = (dirs: string | string[] | undefined) =>
    (Array.isArray(dirs) ? dirs : dirs ? [dirs] : []).filter(Boolean).map((r) => path.resolve(configDir, r));
  const global = Array.isArray(configured) ? resolve(configured) : resolve(configured?.['*']);
  const byOrigin = new Map<string, string[]>();
  if (configured && !Array.isArray(configured)) {
    for (const [key, dirs] of Object.entries(configured)) {
      const origin = key === '*' ? null : originOf(key);
      const resolved = resolve(dirs);
      if (origin && resolved.length) byOrigin.set(origin, resolved);
    }
  }
  const roots = global.length ? global : [configDir];
  return { roots: [...new Set([...roots, repoRoot])], byOrigin, repoRoot };
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The directories a script resolves against: its origin's, else its page's origin's, then the test's roots. */
function scriptRoots(roots: CodeReachRoots, scriptUrl: string, pageUrl: string | undefined): string[] {
  if (!roots.byOrigin?.size) return roots.roots;
  const own = roots.byOrigin.get(originOf(scriptUrl) ?? '') ?? roots.byOrigin.get(originOf(pageUrl) ?? '');
  return own ? [...new Set([...own, ...roots.roots])] : roots.roots;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The existing file a source path names, absolute, or null. */
function resolveSourcePath(source: string, roots: string[]): string | null {
  const normalized = normalizeSourcePath(source);
  if (!normalized || /(?:^|\/)node_modules\//.test(normalized)) return null;
  if (path.isAbsolute(normalized) && isFile(normalized)) return path.resolve(normalized);
  const relative = normalized.replace(/^\/+/, '');
  for (const root of roots) {
    const candidate = path.resolve(root, relative);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Vite dev servers' `base` paths by origin, from the address of their `@vite/client` script. */
type ViteBases = Map<string, string>;

function viteBases(entries: JsCoverageEntry[]): ViteBases {
  const bases: ViteBases = new Map();
  for (const entry of entries) {
    const match = /^(https?:\/\/[^/]+)(\/.*?)@vite\/client$/.exec(entry.url.replace(/[?#].*$/, ''));
    if (match && match[2] !== '/') bases.set(match[1]!, match[2]!);
  }
  return bases;
}

/** The source file a served module's URL names, when it exists and is not build output. */
function fileForUrl(url: string, roots: string[], bases: ViteBases): string | null {
  let pathname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') return null;
    pathname = parsed.pathname;
    const base = bases.get(parsed.origin);
    if (base && pathname.startsWith(base)) pathname = pathname.slice(base.length - 1);
  } catch {
    return null;
  }
  if (!SOURCE_EXTENSIONS.test(pathname) || pathname.startsWith('/@vite/') || pathname.includes('/node_modules/')) {
    return null;
  }
  const file = resolveSourcePath(pathname, roots);
  if (!file || BUILD_DIRS.test(file.replace(/\\/g, '/'))) return null;
  return file;
}

function relativeToRepo(file: string, repoRoot: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/** A script's version: V8's content hash when known, else a hash of its source. */
function scriptVersion(entry: CoveredScript): string {
  return (
    entry.hash ??
    crypto
      .createHash('sha1')
      .update(entry.source ?? '')
      .digest('hex')
  );
}

async function loadMap(entry: CoveredScript, fetchMap: MapFetcher): Promise<SourceMapLookup | null> {
  const ref = entry.source ? sourceMappingUrl(entry.source) : null;
  if (!ref) return null;
  if (ref.startsWith('data:')) {
    const text = decodeDataUrl(ref);
    return text ? parseMap(text) : null;
  }
  let absolute: string;
  try {
    absolute = new URL(ref, entry.url).href;
  } catch {
    return null;
  }
  // Versioned by the script's content: a rebuilt bundle keeps its map's URL but not its mappings.
  const version = scriptVersion(entry);
  let pending = mapCache.get(absolute, version);
  if (!pending) {
    pending = fetchMap(absolute).then((text) => (text ? parseMap(text) : null));
    mapCache.set(absolute, version, pending);
  }
  return pending;
}

function parseMap(text: string): SourceMapLookup | null {
  try {
    return decodeSourceMap(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Resolve a script, from the cache when the worker has resolved its version.
 * A resolution is cached only when the script's source was read: without it,
 * the URL is all there is to go on.
 */
async function resolveScript(
  entry: CoveredScript,
  roots: string[],
  bases: ViteBases,
  fetchMap: MapFetcher,
): Promise<ScriptResolution> {
  const version = scriptVersion(entry);
  const cached = scriptCache.get(entry.url, version);
  if (cached) return cached;
  const file = fileForUrl(entry.url, roots, bases);
  const lookup = await loadMap(entry, fetchMap);
  let resolution: ScriptResolution;
  const text = entry.source === undefined ? undefined : scriptText(entry.source);
  if (file) resolution = { kind: 'file', file, lookup, text };
  else resolution = lookup ? { kind: 'map', lookup, files: [], text } : { kind: 'none' };
  if (text) scriptCache.set(entry.url, version, resolution);
  return resolution;
}

/** The text a script's offsets are read against: its resolution's, else its own source's. */
function textOf(entry: CoveredScript, resolution: { text: ScriptText | undefined }): ScriptText | undefined {
  return resolution.text ?? (entry.source === undefined ? undefined : scriptText(entry.source));
}

/**
 * The repository-relative files the covered scripts reached, sorted and capped.
 * `pageUrl`, the page's address as its coverage stopped, picks the roots of the
 * scripts whose own origin has none.
 */
export async function resolveCodeReach(
  entries: CoveredScript[],
  roots: CodeReachRoots,
  fetchMap: MapFetcher,
  pageUrl?: string,
): Promise<string[]> {
  return finalizeCodeReach((await resolveReach(entries, roots, fetchMap, pageUrl)).keys());
}

/**
 * The repository-relative files the covered scripts reached, each with the
 * start and end line of every function that ran in it (none when the lines are
 * not known: a script whose source was not read).
 */
export async function resolveCodeReachFunctions(
  entries: CoveredScript[],
  roots: CodeReachRoots,
  fetchMap: MapFetcher,
  pageUrl?: string,
): Promise<Map<string, LineRange[]>> {
  return resolveReach(entries, roots, fetchMap, pageUrl);
}

/** The files the covered scripts reached, repository-relative, with the line ranges of their functions that ran. */
async function resolveReach(
  entries: CoveredScript[],
  roots: CodeReachRoots,
  fetchMap: MapFetcher,
  pageUrl: string | undefined,
): Promise<Map<string, LineRange[]>> {
  const files = new Map<string, LineRange[]>();
  const add = (file: string, functions: LineRange[]) => {
    const path = relativeToRepo(file, roots.repoRoot);
    const known = files.get(path);
    if (known) known.push(...functions);
    else files.set(path, [...functions]);
  };
  const bases = viteBases(entries);
  const scripts = entries.filter((entry) => entry.url && entry.functions?.length && !REPLAYED_SCRIPT.test(entry.url));
  // Every script is looked up before the first is resolved: caching one may evict another this test still needs.
  const known = scripts.map((entry) => scriptCache.get(entry.url, scriptVersion(entry)));
  for (const [i, covered] of scripts.entries()) {
    const dirs = scriptRoots(roots, covered.url, pageUrl);
    const resolution = known[i] ?? (await resolveScript(covered, dirs, bases, fetchMap));
    if (resolution.kind === 'file') {
      if (!resolution.file) continue;
      const text = textOf(covered, resolution);
      if (resolution.lookup) {
        // A module with its own map counts for the functions that map to its source, at the lines they map to.
        const reached = reachedFunctionLines(covered, resolution.lookup, text);
        if (reached.size > 0) add(resolution.file, [...reached.values()].flat());
      } else if (scriptRan(covered, text)) {
        add(resolution.file, reachedFunctionLines(covered, null, text).get(-1) ?? []);
      }
    } else if (resolution.kind === 'map') {
      const entry = covered;
      for (const [index, functions] of reachedFunctionLines(covered, resolution.lookup, textOf(covered, resolution))) {
        if (resolution.files[index] === undefined) {
          const source = resolution.lookup.sources[index] ?? '';
          let absolute = resolveSourcePath(source, dirs);
          // A source relative to the map: resolve it as a URL path, then against the roots.
          if (!absolute && !/^[a-z][\w+.-]*:/i.test(source)) {
            try {
              absolute = fileForUrl(new URL(source, entry.url).href, dirs, bases);
            } catch {
              absolute = null;
            }
          }
          resolution.files[index] = absolute;
        }
        const file = resolution.files[index];
        if (file) add(file, functions);
      }
    }
  }
  return files;
}

/** A map fetcher through the page's request context, bounded in size and time. */
export function pageMapFetcher(page: Page): MapFetcher {
  return async (url) => {
    try {
      const response = await internalCall(page, () => page.request.get(url, { timeout: MAP_TIMEOUT_MS }));
      if (!response.ok()) return null;
      const length = Number(response.headers()['content-length'] ?? 0);
      if (length > MAX_MAP_BYTES) return null;
      const body = await response.body();
      return body.length > MAX_MAP_BYTES ? null : body.toString('utf-8');
    } catch {
      return null;
    }
  };
}

/** Whether a page runs in Chromium, the only browser with JavaScript coverage. */
function isChromiumPage(page: Page): boolean {
  try {
    return page.context().browser()?.browserType().name() === 'chromium';
  } catch {
    return false;
  }
}

/** A script the page parsed: its URL and V8's content hash. */
interface ParsedScript {
  url: string;
  hash: string;
}

/** One script's function coverage, as `Profiler.takePreciseCoverage` reports it. */
interface ScriptCoverage {
  scriptId: string;
  functions: CoveredScript['functions'];
}

/** The function coverage running on one page, through its own CDP session. */
interface CoverageCapture {
  cdp: CDPSession;
  /** The scripts parsed since the capture started, by script id. */
  scripts: Map<string, ParsedScript>;
  /** The sources read, by script version; a failed read is dropped, so a later parse of that version reads again. */
  sources: Map<string, Promise<string | null>>;
  /** The coverage read as each document was left, in order; each read holds what ran since the last one. */
  reads: Array<Promise<ScriptCoverage[]>>;
}

const captures = new WeakMap<Page, CoverageCapture>();

/** The isolated world the capture marks each document from, out of the page's reach. */
const MARK_WORLD = 'piwi-code-reach';

/**
 * A `beforeunload` listener that does nothing: the debugger pauses on it as its
 * document is being left, while the document is still there, and the coverage is
 * read during the pause. A command sent once the navigation started would only
 * reach the next document.
 */
const MARK_FUNCTION = 'piwiCodeReachMark';
const MARK_SOURCE = `addEventListener('beforeunload', function ${MARK_FUNCTION}() {});`;

/** The documents of each page that carry the mark, by loader id; a document keeps it from one test to the next. */
const markedDocuments = new WeakMap<Page, Set<string>>();

function marksOf(page: Page): Set<string> {
  let marks = markedDocuments.get(page);
  if (!marks) {
    marks = new Set();
    markedDocuments.set(page, marks);
  }
  return marks;
}

/** Mark the page's current document, unless it already carries the mark; best-effort. */
async function markCurrentDocument(page: Page, cdp: CDPSession): Promise<void> {
  try {
    const { frameTree } = await internalCall(page, () => cdp.send('Page.getFrameTree'));
    const marks = marksOf(page);
    if (marks.has(frameTree.frame.loaderId)) return;
    const world = await internalCall(page, () =>
      cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: MARK_WORLD }),
    );
    await internalCall(page, () =>
      cdp.send('Runtime.evaluate', { expression: MARK_SOURCE, contextId: world.executionContextId }),
    );
    marks.add(frameTree.frame.loaderId);
  } catch {
    // The document stays unmarked: what it ran is read when the capture stops, if it is still there.
  }
}

/**
 * Release every pause: the debugger runs only to learn the scripts and to stop
 * as a document is left, when the coverage is read first.
 */
function onPaused(
  page: Page,
  capture: CoverageCapture,
  event: { reason: string; data?: unknown; callFrames?: Array<{ functionName: string }> },
): void {
  // The page's own `beforeunload` listeners stop the debugger too: only the mark's stop reads.
  const leaving =
    event.reason === 'EventListener' &&
    (event.data as { eventName?: string } | undefined)?.eventName === 'listener:beforeunload' &&
    (event.callFrames?.[0]?.functionName ?? MARK_FUNCTION) === MARK_FUNCTION;
  const read = leaving ? readCoverage(page, capture.cdp) : null;
  if (read) capture.reads.push(read);
  void (read ?? Promise.resolve()).finally(() => {
    internalCall(page, () => capture.cdp.send('Debugger.resume')).catch(() => {});
  });
}

function versionKey(url: string, hash: string): string {
  return `${hash} ${url}`;
}

/**
 * Record a parsed script, and read its source now, while its document is
 * still there, when the worker has not resolved this version of it yet.
 * Scripts without a URL (the page's inline handlers, Playwright's own
 * evaluations) are left out, and so are replayed server stacks. The source of a
 * dependency (`node_modules`, a dev server's own client) is never read: it counts
 * for no file.
 */
function onScriptParsed(
  page: Page,
  capture: CoverageCapture,
  event: { scriptId: string; url: string; hash: string },
): void {
  if (!event.url || REPLAYED_SCRIPT.test(event.url)) return;
  capture.scripts.set(event.scriptId, { url: event.url, hash: event.hash });
  if (NEVER_REACHED.test(event.url)) return;
  const key = versionKey(event.url, event.hash);
  if (capture.sources.has(key) || scriptCache.get(event.url, event.hash)) return;
  const source: Promise<string | null> = internalCall(page, () =>
    capture.cdp.send('Debugger.getScriptSource', { scriptId: event.scriptId }),
  ).then(
    (response) => response.scriptSource,
    () => {
      if (capture.sources.get(key) === source) capture.sources.delete(key);
      return null;
    },
  );
  capture.sources.set(key, source);
}

/** Read the coverage gathered since the last read: V8 resets what it reports at each read. */
function readCoverage(page: Page, cdp: CDPSession): Promise<ScriptCoverage[]> {
  return internalCall(page, () => cdp.send('Profiler.takePreciseCoverage')).then(
    (taken) => taken.result as ScriptCoverage[],
    () => [],
  );
}

/**
 * The reads of a capture as one coverage per script: a function counts when it
 * ran in any read. Functions keep the order of their first read, so a script's
 * top-level function stays its first.
 */
export function mergeCoverageReads(reads: ScriptCoverage[][]): Map<string, CoveredScript['functions']> {
  const merged = new Map<string, CoveredScript['functions']>();
  const byRange = new Map<string, Map<string, CoveredScript['functions'][number]>>();
  for (const read of reads) {
    for (const script of read) {
      let functions = merged.get(script.scriptId);
      let ranges = byRange.get(script.scriptId);
      if (!functions || !ranges) {
        functions = [];
        ranges = new Map();
        merged.set(script.scriptId, functions);
        byRange.set(script.scriptId, ranges);
      }
      for (const fn of script.functions) {
        const whole = fn.ranges[0];
        if (!whole) continue;
        const key = `${whole.startOffset}:${whole.endOffset}`;
        const known = ranges.get(key);
        if (!known) {
          const copy = { ...fn, ranges: fn.ranges.map((range) => ({ ...range })) };
          ranges.set(key, copy);
          functions.push(copy);
        } else if (whole.count > known.ranges[0]!.count) {
          known.ranges[0]!.count = whole.count;
        }
      }
    }
  }
  return merged;
}

async function detach(page: Page, cdp: CDPSession): Promise<void> {
  try {
    await internalCall(page, () => cdp.detach());
  } catch {
    // The page or its context is already gone, and the session with it.
  }
}

/**
 * Start function coverage on a page, with the debugger on to learn each
 * script's version and to stop as each document is left (its `beforeunload`,
 * from a listener the capture adds in an isolated world); false when the
 * browser has none or it fails.
 */
export async function startCodeReach(page: Page): Promise<boolean> {
  if (!isChromiumPage(page) || captures.has(page)) return false;
  let cdp: CDPSession | null = null;
  try {
    cdp = await internalCall(page, () => page.context().newCDPSession(page));
    const capture: CoverageCapture = { cdp, scripts: new Map(), sources: new Map(), reads: [] };
    const marks = marksOf(page);
    cdp.on('Debugger.scriptParsed', (event) => onScriptParsed(page, capture, event));
    cdp.on('Debugger.paused', (event) => onPaused(page, capture, event));
    // A document the main frame commits while the capture runs gets the mark from the script added below.
    cdp.on('Page.frameNavigated', (event) => {
      if (!event.frame.parentId) marks.add(event.frame.loaderId);
    });
    await internalCall(page, () =>
      Promise.all([
        capture.cdp.send('Debugger.enable'),
        capture.cdp.send('Profiler.enable'),
        capture.cdp.send('Profiler.startPreciseCoverage', { callCount: false, detailed: false }),
        capture.cdp.send('Page.enable'),
        capture.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MARK_SOURCE, worldName: MARK_WORLD }),
        capture.cdp.send('DOMDebugger.setEventListenerBreakpoint', { eventName: 'beforeunload' }),
      ]),
    );
    await markCurrentDocument(page, capture.cdp);
    captures.set(page, capture);
    return true;
  } catch {
    if (cdp) await detach(page, cdp);
    return false;
  }
}

/**
 * Stop the page's coverage and return the scripts parsed since it started,
 * each with its functions and version; null when it cannot be read.
 */
export async function stopCodeReach(page: Page): Promise<CoveredScript[] | null> {
  const capture = captures.get(page);
  if (!capture) return null;
  captures.delete(page);
  const { cdp } = capture;
  try {
    const last = await internalCall(page, async () => {
      const taken = await cdp.send('Profiler.takePreciseCoverage');
      await cdp.send('Profiler.stopPreciseCoverage');
      return taken.result as ScriptCoverage[];
    });
    const coverage = mergeCoverageReads([...(await Promise.all(capture.reads)), last]);
    const entries: CoveredScript[] = [];
    for (const [scriptId, functions] of coverage) {
      const parsed = capture.scripts.get(scriptId);
      if (!parsed) continue;
      const entry: CoveredScript = { url: parsed.url, hash: parsed.hash, functions };
      const source = await capture.sources.get(versionKey(parsed.url, parsed.hash));
      if (source != null) entry.source = source;
      entries.push(entry);
    }
    return entries;
  } catch {
    return null;
  } finally {
    await detach(page, cdp);
  }
}

/** Forget the per-worker caches (tests only). */
export function resetCodeReachCaches(): void {
  scriptCache.clear();
  mapCache.clear();
  cachedRepoRoot = null;
}
