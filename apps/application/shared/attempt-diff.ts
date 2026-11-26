/**
 * Diff two attempts of the same test — the attempt that failed against the one
 * that passed on retry. The result is the flakiness fingerprint: what was
 * different the one time the test failed. Computed entirely from evidence Piwi
 * already stores per attempt (each attempt is its own execution row), so no new
 * capture is needed.
 *
 * Pure and dependency-light: it never throws on partial data. An attempt with no
 * fixtures simply yields fewer diff rows — an error-only pair still produces the
 * error row. Shared by the REST endpoint and the demo mirror, and its
 * network/console signal feeds the flaky root-cause classifier.
 */
import { stepLabel } from '@piwitests/core/step-analysis';
import type { ParsedPlaywrightError } from '#shared/error-parse';
import type { PageStateLike } from '#shared/page-state';
import { requestRouteKey } from '#shared/utils/route';
import { SLOWER_FACTOR, isMuchSlower, stepMatchKey } from '#shared/duration-standout';
import { isConsoleErrorType, isPageErrorType } from '#shared/console-entries';

/** One attempt's evidence, as loaded from its execution row. All fields optional. */
export interface AttemptEvidence {
  error?: string | null;
  parsedError?: ParsedPlaywrightError | null;
  steps?: AttemptStep[] | null;
  networkRequests?: AttemptNetworkRequest[] | null;
  consoleLogs?: AttemptConsoleEntry[] | null;
  pageState?: PageStateLike | null;
  ariaSnapshot?: string | null;
  duration?: number | null;
}

export interface AttemptStep {
  title: string;
  /** The step's target (rendered locator or URL), carried separately by newer Playwright. */
  subtitle?: string | null;
  /** Curated per-step arguments — the tiebreaker when two steps share a label. */
  params?: Record<string, string | number | boolean> | null;
  duration?: number | null;
  category?: string | null;
  failed?: boolean | null;
  error?: { message?: string } | null;
}

export interface AttemptNetworkRequest {
  method?: string | null;
  url?: string | null;
  status?: number | null;
  duration?: number | null;
  resourceType?: string | null;
  /** Why the request failed without a response (`net::ERR_CONNECTION_RESET`). */
  failure?: string | null;
}

export interface AttemptConsoleEntry {
  type?: string | null;
  text?: string | null;
}

export type AttemptDiffKind = 'error' | 'network' | 'console' | 'step' | 'duration' | 'page-state' | 'aria';

export interface AttemptDiffEntry {
  kind: AttemptDiffKind;
  /** One-line description of the difference. */
  summary: string;
  /** Longer text (an error body, a request line, a step message); null when the summary says it all. */
  detail: string | null;
  /**
   * Which attempt the evidence sits on. Omitted for a symmetric "changed"
   * difference present on both (a duration delta, a moved URL).
   */
  only?: 'failing' | 'passing';
  /** The evidence section this difference cites, for a jump-to chip. */
  ref?: { section: string };
  /**
   * The request's route key (`GET /api/cart`) on a network row — the key the
   * flake profile's route suspects carry, so a row can link to its suspect.
   */
  route?: string;
}

/** The ordered list of differences, most-diagnostic first. */
export type AttemptDiff = AttemptDiffEntry[];

/** Kinds in most-diagnostic-first order; used to rank the final list. */
const KIND_RANK: Record<AttemptDiffKind, number> = {
  error: 0,
  network: 1,
  console: 2,
  step: 3,
  duration: 4,
  'page-state': 5,
  aria: 6,
};

/** A request is treated as failed when the server erred or the request never completed. */
function requestFailed(status: number | null | undefined): boolean {
  const s = status ?? 0;
  return s === 0 || s >= 500;
}

/** Requests are compared by route key, so two ids or queries of one endpoint match. */
function requestKey(r: AttemptNetworkRequest): string {
  return requestRouteKey(r.method, r.url);
}

/** Normalize a console message to a stable key (collapse whitespace, cap length). */
function consoleKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase();
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
  return line.trim();
}

/** A short headline for an error, preferring the parsed message head. */
function errorHeadline(evidence: AttemptEvidence): string {
  const head = evidence.parsedError?.messageHead?.trim();
  if (head) return firstLine(head);
  return evidence.error ? firstLine(evidence.error) : 'Error';
}

/** Roles that mark a structural node in a Playwright ARIA (YAML) snapshot. */
const ARIA_STRUCTURAL_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'region',
  'search',
  'form',
  'article',
  'heading',
  'dialog',
  'alertdialog',
  'tablist',
  'tabpanel',
]);

/**
 * Region-header-level nodes of an ARIA snapshot: the landmark and heading lines,
 * as `role "name"`. Playwright snapshots are YAML (`- heading "Title" [level=1]`),
 * so this reads the structure without touching raw HTML.
 */
function ariaStructure(snapshot: string): Set<string> {
  const out = new Set<string>();
  for (const raw of snapshot.split('\n')) {
    const m = /^\s*-\s*([a-zA-Z]+)(?:\s+"([^"]*)")?/.exec(raw);
    if (!m) continue;
    const role = m[1]!.toLowerCase();
    if (!ARIA_STRUCTURAL_ROLES.has(role)) continue;
    out.add(m[2] ? `${role} "${m[2]}"` : role);
  }
  return out;
}

/** A duration difference below this (ms) is noise, not a signal. */
const DURATION_DELTA_MS = 1000;
/**
 * A request is much slower on the failing attempt when it took at least this
 * many ms and `SLOWER_FACTOR` times as long as on the passing one. A step is
 * much slower by `isMuchSlower`, which reads the difference instead.
 */
const REQUEST_SLOW_MS = 1000;
/** Cap per-category diff rows so a noisy attempt does not flood the list. */
const MAX_PER_CATEGORY = 5;

/**
 * Diff the failing attempt against the passing one. The two are the same test in
 * the same run on the same browser, one retry apart.
 */
export function diffAttempts(failing: AttemptEvidence, passing: AttemptEvidence): AttemptDiff {
  const diffs: AttemptDiffEntry[] = [];

  // ── Error: present on the failing attempt, gone on the pass ────────────────
  const failError = failing.error?.trim() ? failing.error.trim() : null;
  const passError = passing.error?.trim() ? passing.error.trim() : null;
  if (failError && failError !== passError) {
    diffs.push({
      kind: 'error',
      summary: errorHeadline(failing),
      detail: failError,
      only: 'failing',
      ref: { section: 'executionError' },
    });
  } else if (passError && !failError) {
    diffs.push({
      kind: 'error',
      summary: errorHeadline(passing),
      detail: passError,
      only: 'passing',
      ref: { section: 'executionError' },
    });
  }

  // ── Network: a request that failed on one attempt but not the other ────────
  const failNet = failing.networkRequests ?? [];
  const passNet = passing.networkRequests ?? [];
  const failFailedKeys = failedRequestKeys(failNet);
  const passFailedKeys = failedRequestKeys(passNet);
  for (const [side, req] of orderedRequestDiff(failNet, passNet, failFailedKeys, passFailedKeys)) {
    const route = requestKey(req);
    diffs.push({
      kind: 'network',
      summary: `${route} → ${req.failure || (req.status ?? 0)}`,
      detail: req.url || null,
      only: side,
      ref: { section: 'networkRequests' },
      route,
    });
  }

  // ── Network: a request made on both attempts, much slower on the failing one ─
  for (const entry of slowerRequestDiffs(failNet, passNet)) {
    diffs.push(entry);
  }

  // ── Console: an error, warning or uncaught page error on only one attempt ──
  for (const entry of onlyConsoleEntries(failing.consoleLogs ?? [], passing.consoleLogs ?? [], 'failing')) {
    diffs.push(entry);
  }
  for (const entry of onlyConsoleEntries(passing.consoleLogs ?? [], failing.consoleLogs ?? [], 'passing')) {
    diffs.push(entry);
  }

  // ── Steps: a step that errored, or was much slower, on one attempt ─────────
  for (const entry of stepDiffs(failing.steps ?? [], passing.steps ?? [])) {
    diffs.push(entry);
  }

  // ── Duration: the whole attempt ran meaningfully longer or shorter ─────────
  const fd = failing.duration;
  const pd = passing.duration;
  if (fd != null && pd != null && Math.abs(fd - pd) >= DURATION_DELTA_MS) {
    const slower = fd > pd;
    diffs.push({
      kind: 'duration',
      summary: `Failing attempt was ${formatMs(Math.abs(fd - pd))} ${slower ? 'slower' : 'faster'}`,
      detail: `${formatMs(fd)} on the failing attempt vs ${formatMs(pd)} on the pass`,
      ref: { section: 'steps' },
    });
  }

  // ── Page state / URL: where each attempt ended, and what storage it held ───
  for (const entry of pageStateDiffs(failing.pageState ?? null, passing.pageState ?? null)) {
    diffs.push(entry);
  }

  // ── ARIA: a structural node present on only one attempt ────────────────────
  if (failing.ariaSnapshot && passing.ariaSnapshot) {
    for (const entry of ariaDiffs(failing.ariaSnapshot, passing.ariaSnapshot)) {
      diffs.push(entry);
    }
  }

  return stableSortByKind(diffs);
}

function failedRequestKeys(requests: AttemptNetworkRequest[]): Map<string, AttemptNetworkRequest> {
  const map = new Map<string, AttemptNetworkRequest>();
  for (const r of requests) {
    if (requestFailed(r.status)) map.set(requestKey(r), r);
  }
  return map;
}

/** Failed requests present on one side only, failing side first, capped. */
function orderedRequestDiff(
  _failNet: AttemptNetworkRequest[],
  _passNet: AttemptNetworkRequest[],
  failFailed: Map<string, AttemptNetworkRequest>,
  passFailed: Map<string, AttemptNetworkRequest>,
): Array<['failing' | 'passing', AttemptNetworkRequest]> {
  const out: Array<['failing' | 'passing', AttemptNetworkRequest]> = [];
  for (const [key, req] of failFailed) {
    if (!passFailed.has(key)) out.push(['failing', req]);
    if (out.length >= MAX_PER_CATEGORY) return out;
  }
  for (const [key, req] of passFailed) {
    if (!failFailed.has(key)) out.push(['passing', req]);
    if (out.length >= MAX_PER_CATEGORY) return out;
  }
  return out;
}

/** Each answered request's slowest duration, keyed by route. */
function slowestByRequest(requests: AttemptNetworkRequest[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of requests) {
    if (requestFailed(r.status) || r.duration == null) continue;
    const key = requestKey(r);
    map.set(key, Math.max(map.get(key) ?? 0, r.duration));
  }
  return map;
}

/**
 * Requests made on both attempts whose slowest call on the failing attempt took
 * at least `REQUEST_SLOW_MS` and `SLOWER_FACTOR` times as long as on the passing one, slowest
 * gap first. The request exists on both sides, so the row names no side.
 */
function slowerRequestDiffs(failNet: AttemptNetworkRequest[], passNet: AttemptNetworkRequest[]): AttemptDiffEntry[] {
  const passSlowest = slowestByRequest(passNet);
  const slower: Array<{ key: string; failMs: number; passMs: number }> = [];
  for (const [key, failMs] of slowestByRequest(failNet)) {
    const passMs = passSlowest.get(key);
    if (passMs == null) continue;
    if (failMs >= REQUEST_SLOW_MS && failMs >= SLOWER_FACTOR * passMs) slower.push({ key, failMs, passMs });
  }
  return slower
    .sort((a, b) => b.failMs - b.passMs - (a.failMs - a.passMs))
    .slice(0, MAX_PER_CATEGORY)
    .map(({ key, failMs, passMs }) => ({
      kind: 'network' as const,
      summary: `${key} ${formatMs(failMs)} on the failing attempt, ${formatMs(passMs)} on the passing one`,
      detail: null,
      ref: { section: 'networkRequests' },
      route: key,
    }));
}

function onlyConsoleEntries(
  side: AttemptConsoleEntry[],
  other: AttemptConsoleEntry[],
  only: 'failing' | 'passing',
): AttemptDiffEntry[] {
  const otherKeys = new Set(other.filter((e) => isConsoleProblem(e)).map((e) => consoleKey(e.text ?? '')));
  const seen = new Set<string>();
  const out: AttemptDiffEntry[] = [];
  for (const e of side) {
    if (!isConsoleProblem(e)) continue;
    const text = (e.text ?? '').trim();
    if (!text) continue;
    const key = consoleKey(text);
    if (otherKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'console',
      summary: `${consoleProblem(e)} on only the ${only} attempt`,
      detail: text,
      only,
      ref: { section: 'console' },
    });
    if (out.length >= MAX_PER_CATEGORY) break;
  }
  return out;
}

function isConsoleProblem(e: AttemptConsoleEntry): boolean {
  const t = (e.type ?? '').toLowerCase();
  return isConsoleErrorType(t) || t === 'warning' || t === 'warn';
}

/** A console problem as a diff row names it: `Console error`, `Console warning`, `Uncaught page error`. */
function consoleProblem(e: AttemptConsoleEntry): string {
  if (isPageErrorType(e.type)) return 'Uncaught page error';
  return isConsoleErrorType(e.type) ? 'Console error' : 'Console warning';
}

/**
 * The params that changed between two same-label steps, as `key: failing → passing`
 * lines (a key present on only one side reads as `∅` on the other). Null when the
 * two carry the same params.
 */
function paramsDiffLines(failing: AttemptStep, passing: AttemptStep): string | null {
  const f = failing.params ?? {};
  const p = passing.params ?? {};
  const keys = [...new Set([...Object.keys(f), ...Object.keys(p)])];
  const changed = keys.filter((k) => String(f[k] ?? '') !== String(p[k] ?? ''));
  if (changed.length === 0) return null;
  return changed.map((k) => `${k}: ${k in f ? f[k] : '∅'} → ${k in p ? p[k] : '∅'}`).join('\n');
}

function stepDiffs(failSteps: AttemptStep[], passSteps: AttemptStep[]): AttemptDiffEntry[] {
  // Align on the label (title + subtitle), so newer Playwright's bare "Click"
  // titles do not collapse every action onto one key; params disambiguate two
  // steps that still share a label.
  const passByKey = new Map<string, AttemptStep>();
  const passByLabel = new Map<string, AttemptStep>();
  for (const s of passSteps) {
    const label = stepLabel(s);
    const key = stepMatchKey(s);
    if (!passByKey.has(key)) passByKey.set(key, s);
    if (!passByLabel.has(label)) passByLabel.set(label, s);
  }
  const out: AttemptDiffEntry[] = [];
  for (const s of failSteps) {
    const label = stepLabel(s);
    const twin = passByKey.get(stepMatchKey(s)) ?? passByLabel.get(label);
    const failed = Boolean(s.failed || s.error?.message);
    if (failed && !(twin && (twin.failed || twin.error?.message))) {
      out.push({
        kind: 'step',
        summary: `Step "${label}" errored on only the failing attempt`,
        detail: s.error?.message ?? null,
        only: 'failing',
        ref: { section: 'steps' },
      });
    } else if (twin && s.duration != null && twin.duration != null) {
      const delta = s.duration - twin.duration;
      if (isMuchSlower(s.duration, twin.duration)) {
        out.push({
          kind: 'step',
          summary: `Step "${label}" was ${formatMs(delta)} slower on the failing attempt`,
          detail: `${formatMs(s.duration)} vs ${formatMs(twin.duration)}`,
          only: 'failing',
          ref: { section: 'steps' },
        });
      }
    }
    // A step run on both attempts whose params (a URL, a value, a test.step
    // input) differed — the change often is the difference between the runs.
    const labelTwin = passByLabel.get(label);
    if (labelTwin) {
      const paramLines = paramsDiffLines(s, labelTwin);
      if (paramLines) {
        out.push({
          kind: 'step',
          summary: `Step "${label}" ran with different params`,
          detail: paramLines,
          ref: { section: 'steps' },
        });
      }
    }
    if (out.length >= MAX_PER_CATEGORY) break;
  }
  return out;
}

function pageStateDiffs(failing: PageStateLike | null, passing: PageStateLike | null): AttemptDiffEntry[] {
  if (!failing || !passing) return [];
  const out: AttemptDiffEntry[] = [];
  if (failing.url && passing.url && failing.url !== passing.url) {
    out.push({
      kind: 'page-state',
      summary: 'The page ended on a different URL',
      detail: `${failing.url} on the failing attempt vs ${passing.url} on the pass`,
      ref: { section: 'appState' },
    });
  }
  const storageChanges = [
    keyDiffLine('localStorage', failing.localStorage, passing.localStorage),
    keyDiffLine('sessionStorage', failing.sessionStorage, passing.sessionStorage),
    keyDiffLine('cookies', failing.cookies, passing.cookies),
  ].filter((l): l is string => l != null);
  for (const line of storageChanges) {
    out.push({ kind: 'page-state', summary: line, detail: null, ref: { section: 'appState' } });
  }
  return out;
}

/** A one-line summary of which storage/cookie keys the failing attempt gained or lost. */
function keyDiffLine(
  label: string,
  failing: Array<{ key?: string; name?: string }> | null | undefined,
  passing: Array<{ key?: string; name?: string }> | null | undefined,
): string | null {
  const nameOf = (e: { key?: string; name?: string }) => e.key ?? e.name ?? '';
  const f = new Set((failing ?? []).map(nameOf).filter(Boolean));
  const p = new Set((passing ?? []).map(nameOf).filter(Boolean));
  const added = [...f].filter((k) => !p.has(k));
  const removed = [...p].filter((k) => !f.has(k));
  if (added.length === 0 && removed.length === 0) return null;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`had ${added.join(', ')}`);
  if (removed.length > 0) parts.push(`was missing ${removed.join(', ')}`);
  return `${label}: the failing attempt ${parts.join('; ')}`;
}

function ariaDiffs(failing: string, passing: string): AttemptDiffEntry[] {
  const f = ariaStructure(failing);
  const p = ariaStructure(passing);
  const out: AttemptDiffEntry[] = [];
  for (const node of f) {
    if (!p.has(node)) {
      out.push({
        kind: 'aria',
        summary: `${node} was present on only the failing attempt`,
        detail: null,
        only: 'failing',
        ref: { section: 'ariaSnapshot' },
      });
    }
    if (out.length >= MAX_PER_CATEGORY) return out;
  }
  for (const node of p) {
    if (!f.has(node)) {
      out.push({
        kind: 'aria',
        summary: `${node} was present on only the passing attempt`,
        detail: null,
        only: 'passing',
        ref: { section: 'ariaSnapshot' },
      });
    }
    if (out.length >= MAX_PER_CATEGORY) return out;
  }
  return out;
}

/** Order by kind rank, keeping insertion order within a kind (a stable sort). */
function stableSortByKind(diffs: AttemptDiffEntry[]): AttemptDiffEntry[] {
  return diffs
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => KIND_RANK[a.entry.kind] - KIND_RANK[b.entry.kind] || a.index - b.index)
    .map(({ entry }) => entry);
}

function formatMs(ms: number): string {
  const v = Math.round(ms);
  if (v < 1000) return `${v} ms`;
  return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} s`;
}
