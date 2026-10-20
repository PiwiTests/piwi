/**
 * Server-side locator healing — lookup alternatives for failing locators.
 *
 * Queries the normalized `locator_snapshots` table by test_case_id + location,
 * with fallback to element-fingerprint matching against the current page (the
 * "element changed" case), fuzzy matching by locator signature, and ARIA
 * snapshot generation when no prior snapshot exists.
 */
import { and, eq, ne, notInArray, sql, inArray } from 'drizzle-orm';
import { locatorSnapshots, testCases, testRuns, testRunsCases, type LocatorSnapshotRow } from '../database/schema';
import { extractLeafSelector } from '#shared/error-fingerprint';
import { canonicalLocator } from '#shared/locator-chain';
import { loadRunLocatorBreaks, type RunLocatorBreak } from '#shared/handlers/locator-breaks';
import { classifyLocatorResolution } from '#shared/locator-resolution';
import {
  locatorSignatureFromExpression,
  locatorExpressionMethod,
  parseLocatorExpression,
  locatorSignature,
  recommendLocatorFix,
  locatorIdentityEquals,
  alternativeUsesName,
  computeNarrowingSuggestion,
} from '#shared/locator-healing';
import {
  elementMatchOutcome,
  generateFromAriaSnapshot,
  parseAriaCandidates,
  type ElementFingerprint,
} from '#shared/locator-fingerprint';
import { extractLocatorChain, parsePlaywrightError } from '#shared/error-parse';
import { ariaTextPreferJson } from '#shared/aria-json';
import { buildHealEdit } from '#shared/heal-edit';
import { inlineCasePayloads, resolveCasePayloadContents } from './case-payloads';
import type {
  RankedLocator,
  LocatorSnapshot,
  LocatorHealingResult,
  ElementAttributes,
} from '#shared/locator-healing.types';
import type { DrizzleDB } from '#shared/handlers/db';
import type { LocatorHealDetails } from '#shared/handback-outcomes';
import { listOutcomes, type OutcomeRecord } from './outcomes';

// The payload shape lives in shared/ so the API handler, MCP tools, AI context
// and the dashboard panel all agree on it; re-exported for existing importers.
export type { LocatorHealingResult, LocatorHealingSource } from '#shared/locator-healing.types';

/**
 * Extract the call-site location (`file:line:col`) from a Playwright error's
 * stack frames — the first frame outside node_modules and Node internals.
 * Handles both anonymous frames (`at tests/x.spec.ts:42:5`) and named ones
 * (`at Object.foo (tests/x.spec.ts:42:5)`), mirroring `extractTopFrameFile`.
 */
export function extractErrorLocation(error: string): string | null {
  const frameRe = /^\s+at (?:.*? \()?([^()\s][^()]*?):(\d+):(\d+)\)?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = frameRe.exec(error)) !== null) {
    const file = m[1]!.replace(/\\/g, '/');
    if (file.includes('node_modules') || file.startsWith('node:')) continue;
    return `${file}:${m[2]}:${m[3]}`;
  }
  return null;
}

/**
 * Pull the failing source line (number + text) out of a captured `testSource`
 * snippet. The reporter formats each line as `<marker><padded line no> | <code>`
 * and marks the failing line with `> ` (see reporter `source-snippet.ts`). Prefer
 * that marked line; fall back to the line whose number matches `location`.
 */
export function parseFailingSourceLine(
  testSource: string | null | undefined,
  location: string | null,
): { line: number; text: string } | null {
  if (!testSource) return null;
  const rowRe = /^([>*\s])\s*(\d+)\s*\|\s?(.*)$/;
  const locLine = location ? Number(splitFileLine(location)[1]) : NaN;
  let fallback: { line: number; text: string } | null = null;
  for (const raw of testSource.split('\n')) {
    const m = rowRe.exec(raw);
    if (!m) continue;
    const line = Number(m[2]);
    const text = m[3]!;
    if (m[1] === '>') return { line, text };
    if (!Number.isNaN(locLine) && line === locLine) fallback = { line, text };
  }
  return fallback;
}

/**
 * Assemble a result, computing the convention-preserving recommendation over
 * whichever alternative list is active. Element-match (fresh, current-page)
 * wins over prior-success (pre-captured), which wins over the ARIA fallback.
 * Kept in one place so every return path picks the recommendation the same way.
 */
/** Sources whose alternative scores are real stability scores from a pre-captured DOM snapshot. */
const STABILITY_SCORED_SOURCES = new Set<LocatorHealingResult['source']>(['prior-run', 'fingerprint', 'cross-test']);

function buildHealingResult(
  failingLocator: LocatorHealingResult['failingLocator'],
  fromPriorSuccess: RankedLocator[] | null,
  fromAriaSnapshot: RankedLocator[] | null,
  source: LocatorHealingResult['source'],
  fromElementMatch: RankedLocator[] | null = null,
  capturedAt: Date | null = null,
  opts: {
    recommendFrom?: RankedLocator[];
    priorNameMayBeStale?: boolean;
    fromDiffRename?: RankedLocator[];
    diffRename?: LocatorHealingResult['diffRename'];
  } = {},
): LocatorHealingResult {
  const alternatives = opts.fromDiffRename ?? fromElementMatch ?? fromPriorSuccess ?? fromAriaSnapshot ?? [];
  // The recommendation may be picked from a filtered pool (stale name-derived
  // entries excluded) while the full list stays visible. An empty pool means
  // nothing trustworthy remains — recommendation: null, never a stale pick.
  const pool = opts.recommendFrom ?? alternatives;
  const recommendation = pool.length ? recommendLocatorFix(failingLocator?.method, pool) : null;
  // "Everything is fragile — add a data-testid" only makes sense when the
  // scores are stability scores. ARIA-fallback scores measure text-overlap
  // relevance and element-match scores are a fixed band, so a low score there
  // says nothing about the element lacking stable hooks.
  if (recommendation && !STABILITY_SCORED_SOURCES.has(source)) {
    recommendation.suggestAddTestId = false;
  }
  return {
    failingLocator,
    fromPriorSuccess,
    fromElementMatch,
    fromAriaSnapshot,
    source,
    recommendation,
    capturedAt: capturedAt ? capturedAt.toISOString() : null,
    ...(opts.priorNameMayBeStale ? { priorNameMayBeStale: true } : {}),
    ...(opts.fromDiffRename ? { fromDiffRename: opts.fromDiffRename, diffRename: opts.diffRename ?? null } : {}),
  };
}

/**
 * Score of a `diff-rename` replacement: the change under test renamed the
 * string, so the rewritten chain is what the author meant. High enough for an
 * auto-heal pull request.
 */
const DIFF_RENAME_SCORE = 95;

/**
 * The run's stored `likely` break whose chain is the failing chain and whose
 * call sites include the failing one (any, when the error names no call site),
 * with a rewrite to offer. A `possible` break, a bare string that happened to
 * match, is not evidence enough for a replacement auto-heal may apply.
 */
function findDiffRename(
  error: string,
  location: string | null,
  breaks: RunLocatorBreak[] | null | undefined,
): RunLocatorBreak | null {
  if (!breaks?.length) return null;
  const raw = extractLocatorChain(error);
  const chain = raw ? canonicalLocator(raw) : null;
  if (!chain) return null;
  return (
    breaks.find(
      (b) =>
        b.confidence === 'likely' &&
        b.rewrite &&
        b.locator === chain &&
        (!location || b.callSites.some((site) => sameFileLine(site, location))),
    ) ?? null
  );
}

/** A `diff-rename` result: the stored rewrite as the one alternative, with the diff as its evidence. */
function diffRenameResult(
  failingLocator: LocatorHealingResult['failingLocator'],
  b: RunLocatorBreak,
): LocatorHealingResult {
  const parsed = parseLocatorExpression(b.rewrite!);
  const rewritten: RankedLocator = {
    locator: b.rewrite!,
    method: parsed?.method ?? failingLocator?.method ?? 'locator',
    args: parsed?.args ?? {},
    score: DIFF_RENAME_SCORE,
  };
  return buildHealingResult(failingLocator, null, null, 'diff-rename', null, null, {
    fromDiffRename: [rewritten],
    diffRename: {
      before: b.anchor.before,
      after: b.anchor.after ?? '',
      file: b.anchor.file,
      line: b.anchor.line,
    },
  });
}

/**
 * The identity of the element a stored snapshot describes — its resolved ARIA
 * role and accessible name. The role/name were resolved against the real DOM at
 * capture time and baked into the stored `getByRole` alternative, so we read
 * them back from there instead of re-deriving a role server-side.
 */
function fingerprintFromSnapshot(priorAlts: RankedLocator[] | null, row: LocatorSnapshotRow): ElementFingerprint {
  const roleAlt = priorAlts?.find((a) => a.method === 'getByRole');
  let role = typeof roleAlt?.args?.role === 'string' ? roleAlt.args.role : null;
  // Fall back to the stored HTML element tag when no getByRole was captured
  // (common for getByText locators on <span>/<div>). Map semantic elements to
  // their implicit ARIA role so the renamed-element match stays scoped.
  if (!role && row.elementTag) {
    role = implicitRoleForTag(row.elementTag);
  }
  const name = typeof roleAlt?.args?.name === 'string' ? roleAlt.args.name : (row.elementText ?? null);

  // Structural identity — heading level and same-role position — narrows the
  // renamed-element match. Level: captured getByRole args, then the h1-h6 tag,
  // then a stored aria-level attribute. rolePosition: newer captures only.
  let attrs: Record<string, unknown> = {};
  try {
    attrs = JSON.parse(row.elementAttrs) as Record<string, unknown>;
  } catch {
    // Legacy/malformed attrs — the fingerprint stays role+name only.
  }
  let level = typeof roleAlt?.args?.level === 'number' ? roleAlt.args.level : null;
  if (level == null && row.elementTag) {
    const tagMatch = row.elementTag.match(/^h([1-6])$/i);
    if (tagMatch) level = Number(tagMatch[1]);
  }
  const ariaLevel = attrs['aria-level'];
  if (level == null && typeof ariaLevel === 'string' && /^\d+$/.test(ariaLevel)) {
    level = Number(ariaLevel);
  }
  const rp = attrs['rolePosition'] as { role?: unknown; count?: unknown; index?: unknown } | null | undefined;
  const rolePosition =
    rp && typeof rp.role === 'string' && typeof rp.count === 'number' && typeof rp.index === 'number'
      ? { role: rp.role, count: rp.count, index: rp.index }
      : null;

  return { role, name, level, rolePosition };
}

/**
 * Map HTML element tags to their implicit ARIA roles so the element-match
 * fingerprint retains role-based scoping even when the stored alternatives
 * had no getByRole entry (which happens for getByText locators on elements
 * without explicit role attributes).
 */
function implicitRoleForTag(tag: string): string | null {
  const MAP: Record<string, string> = {
    a: 'link',
    button: 'button',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
    img: 'img',
    input: 'textbox',
    textarea: 'textbox',
    select: 'combobox',
    nav: 'navigation',
    main: 'main',
    aside: 'complementary',
    header: 'banner',
    footer: 'contentinfo',
    form: 'form',
    table: 'table',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    section: 'region',
    article: 'article',
    dialog: 'dialog',
    label: 'label',
    figcaption: 'caption',
    legend: 'legend',
    td: 'cell',
    th: 'columnheader',
    tr: 'row',
    option: 'option',
    menuitem: 'menuitem',
  };
  return MAP[tag.toLowerCase()] ?? null;
}

/**
 * Given a stored snapshot found by location/signature, decide whether the
 * element still exists on the current page. If it was renamed/moved/replaced,
 * return fresh locators generated from the element it became (`element-match`);
 * otherwise the pre-captured alternatives still describe it (`prior-run` /
 * `fingerprint`).
 *
 * When the stored accessible name is provably gone from the failing page but
 * no rename match was confident (`no-match`), the name-derived alternatives —
 * including the failing locator itself, which capture legitimately recorded —
 * almost certainly no longer match. They stay visible for context, but the
 * recommendation is picked only from the survivors (structural/attribute
 * alternatives), and failure-page ARIA candidates ride along as a supplement.
 * A flaky failure on an unchanged page (`unchanged`) keeps the full pool: the
 * original locator is still the right one there.
 */
function resolveStoredHit(
  failingLocator: LocatorHealingResult['failingLocator'],
  hit: LocatorSnapshotRow,
  ariaSnapshot: string | null,
  priorSource: 'prior-run' | 'fingerprint' | 'cross-test',
): LocatorHealingResult {
  const priorAlts = parseAlternativesColumn(hit);
  const fingerprint = fingerprintFromSnapshot(priorAlts, hit);
  const outcome = elementMatchOutcome(fingerprint, ariaSnapshot);
  if (outcome.status === 'matched') {
    return buildHealingResult(failingLocator, null, null, 'element-match', outcome.fresh);
  }

  if (outcome.status === 'no-match' && fingerprint.name) {
    const staleName = fingerprint.name;
    const survivors = (priorAlts ?? []).filter(
      (a) =>
        !alternativeUsesName(a, staleName) &&
        !(failingLocator && locatorIdentityEquals(a.method, a.args, failingLocator.method, failingLocator.args)),
    );
    const supplement = generateFromAriaSnapshot(ariaSnapshot, failingLocator);
    return buildHealingResult(failingLocator, priorAlts, supplement, priorSource, null, hit.lastSeenAt ?? null, {
      recommendFrom: survivors,
      priorNameMayBeStale: true,
    });
  }

  return buildHealingResult(failingLocator, priorAlts, null, priorSource, null, hit.lastSeenAt ?? null);
}

/**
 * Find alternatives for a failing locator. Loads every snapshot for the test
 * case once (indexed by test_case_id) and resolves the best match in memory:
 *
 * 1. Call-site location — exact `file:line:col`, then `file:line` (tolerates a
 *    column drift). Disambiguates repeated identical locators by where they run.
 * 2. Locator signature — method + ordered string literals; survives line shifts
 *    but cannot tell apart repeated identical locators.
 * 3. ARIA fallback — generated from the current run's ARIA snapshot.
 */
export async function getLocatorHealing(db: DrizzleDB, testRunsCaseId: number): Promise<LocatorHealingResult> {
  // Load the failing row
  const rows = await db
    .select({
      error: testRunsCases.error,
      testCaseId: testRunsCases.testCaseId,
      testRunId: testRunsCases.testRunId,
      ariaSnapshot: testRunsCases.ariaSnapshot,
      ariaSnapshotJson: testRunsCases.ariaSnapshotJson,
      testSource: testRunsCases.testSource,
      ariaSnapshotPayloadId: testRunsCases.ariaSnapshotPayloadId,
      ariaSnapshotJsonPayloadId: testRunsCases.ariaSnapshotJsonPayloadId,
      testSourcePayloadId: testRunsCases.testSourcePayloadId,
      filePath: testCases.filePath,
      playwrightVersion: testRuns.playwrightVersion,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(testRunsCases.id, testRunsCaseId));

  const row = rows[0] ? await inlineCasePayloads(db, rows[0]) : undefined;
  if (!row?.error) return notApplicableResult(null, null);

  const testCaseId = row.testCaseId;

  // Load every snapshot for this test case once (indexed by test_case_id). A
  // case has only a handful of locators, so matching in memory is cheaper than
  // several round-trips and keeps the ladder logic in one place.
  const snaps = testCaseId
    ? await db.select().from(locatorSnapshots).where(eq(locatorSnapshots.testCaseId, testCaseId))
    : [];

  const breaks = await loadRunLocatorBreaks(db, [row.testRunId]);

  const result = await resolveHealingForCase(
    {
      error: row.error,
      ariaSnapshot: row.ariaSnapshot,
      ariaSnapshotJson: row.ariaSnapshotJson,
      playwrightVersion: row.playwrightVersion,
      testSource: row.testSource,
      filePath: row.filePath,
      locatorBreaks: breaks.get(row.testRunId) ?? null,
    },
    snaps,
    testCaseId ? (sig, method) => findCrossTestSnapshot(db, testCaseId, sig, method) : null,
  );
  if (testCaseId) await stampStoredHealedRuns(db, [{ result, testCaseId, failingRunId: row.testRunId }]);
  return result;
}

/** Per-case healing input — the failing execution's stored fields. */
export interface HealingCaseInput {
  error: string | null;
  ariaSnapshot?: string | null;
  /** The failure-time aria tree as JSON (Playwright ≥ 1.63), preferred over the YAML. */
  ariaSnapshotJson?: string | null;
  /** The run's stored Playwright version — gates the `.visible()` narrowing suggestion. */
  playwrightVersion?: string | null;
  testSource?: string | null;
  /**
   * The failing test's own source file, used as the edit's file path when the
   * error carries no stack frame (Piwi-submitted errors often don't). The call
   * site's line still comes from the source snippet.
   */
  filePath?: string | null;
  /** The locator breaks the failing run's diff predicts, for the `diff-rename` rung. */
  locatorBreaks?: RunLocatorBreak[] | null;
}

/** An empty result for a failure healing cannot address, with the one-line reason. */
function notApplicableResult(
  failingLocator: LocatorHealingResult['failingLocator'],
  reason: string | null,
): LocatorHealingResult {
  return {
    ...buildHealingResult(failingLocator, null, null, 'none'),
    applicable: false,
    reason: reason ?? classifyLocatorResolution(null).reason,
  };
}

/**
 * Resolve locator healing for one failing case from its pre-loaded snapshots.
 * The single-case and batch entry points share this one ladder; the DB-touching
 * cross-test lookup is injected as `findCrossTest` (null to skip it) so the core
 * stays directly unit-testable.
 *
 * The ladder only runs for a resolution failure (`classifyLocatorResolution`):
 * a locator that resolved and then failed its action or assertion, a navigation
 * error, or an error naming no locator returns `applicable: false` with a
 * reason and no alternatives — the ARIA fallback included.
 *
 * 0. Diff rename — the run's own diff renamed the string the failing chain
 *    finds its element by, at this call site: the rewritten chain.
 * 1. Call-site location — exact `file:line:col`, then `file:line` (tolerates a
 *    column drift). Disambiguates repeated identical locators by where they run.
 * 2. Locator signature — method + ordered string literals; survives line shifts.
 * 2.5. Cross-test — the same signature captured by another test in the project.
 * 3. ARIA fallback — generated from the failing run's ARIA snapshot.
 *
 * The failing call site and source line are stamped onto whichever rung wins.
 */
/** Role + accessible name the failing locator targets, parsed from its source form. */
function failingRoleName(selector: string | null): { role: string | null; name: string | null } {
  if (!selector) return { role: null, name: null };
  const role = /getByRole\(\s*['"`]([^'"`]+)['"`]/.exec(selector)?.[1] ?? null;
  const name =
    /\bname:\s*['"`]([^'"`]+)['"`]/.exec(selector)?.[1] ??
    /getBy(?:Text|Label|Placeholder|AltText|Title)\(\s*['"`]([^'"`]+)['"`]/.exec(selector)?.[1] ??
    null;
  return { role, name };
}

/**
 * How many nodes in the failure-time aria tree match the failing locator's role
 * and name. The aria snapshot omits hidden elements, so a match here is a
 * *visible* match — exactly what `.visible()` keeps. Null when the tree is
 * absent or the locator names neither a role nor a name to match on.
 */
function visibleMatchCountFromAria(
  aria: string | null,
  target: { role: string | null; name: string | null },
): number | null {
  if (!aria || (!target.role && !target.name)) return null;
  const candidates = parseAriaCandidates(aria);
  if (candidates.length === 0) return null;
  return candidates.filter(
    (c) => (target.role ? c.role === target.role : true) && (target.name ? c.name === target.name : true),
  ).length;
}

/**
 * The ARIA-fallback alternatives that may be recommended. The failing locator's
 * own element can be on the failing page (a strict-mode violation, an element
 * that came late), so the locator that failed stays listed but is never the
 * recommendation. When a failing `getByRole` finds its role and name there, the
 * other alternatives with that name find the same element, or one named like
 * it, and are no fix either. Other methods keep them: an ARIA name can come from
 * an `aria-label`, which `getByText` does not read, so a `getByRole` with the
 * name can fix a failing `getByText`.
 */
function ariaRecommendationPool(
  alternatives: RankedLocator[],
  failingLocator: LocatorHealingResult['failingLocator'],
): RankedLocator[] {
  if (!failingLocator) return alternatives;
  const isFailing = (a: RankedLocator) =>
    locatorIdentityEquals(a.method, a.args, failingLocator.method, failingLocator.args);
  const roleName =
    failingLocator.method === 'getByRole' && typeof failingLocator.args.name === 'string'
      ? failingLocator.args.name
      : null;
  const shownName = roleName !== null && alternatives.some(isFailing) ? roleName : null;
  return alternatives.filter((a) => !isFailing(a) && !(shownName && alternativeUsesName(a, shownName)));
}

export async function resolveHealingForCase(
  input: HealingCaseInput,
  snaps: LocatorSnapshotRow[],
  findCrossTest: ((sig: string, method: string | null) => Promise<LocatorSnapshotRow | null>) | null,
): Promise<LocatorHealingResult> {
  if (!input.error) return notApplicableResult(null, null);
  const error = input.error;
  const aria = ariaTextPreferJson(input.ariaSnapshotJson, input.ariaSnapshot);

  // Parse the failing locator from the error (for display + signature lookup).
  // Use the chain leaf — the innermost call identifies the resolved element and
  // is what the capture side recorded, so chained locators match too.
  const selector = extractLeafSelector(error);
  const parsed = selector ? parseLocatorExpression(selector) : null;
  const failingLocator = parsed ? { method: parsed.method, args: parsed.args } : null;

  const verdict = classifyLocatorResolution(error);
  if (!verdict.applicable) return notApplicableResult(failingLocator, verdict.reason);

  // A strict-mode violation where the failure-time aria tree (which omits hidden
  // nodes) carries just one match is the case `.visible()` exists for. Gated on
  // the run's Playwright being 1.63 or later.
  const parsedErr = parsePlaywrightError(error);
  const narrowing =
    parsedErr.kind === 'strict-mode'
      ? computeNarrowingSuggestion({
          playwrightVersion: input.playwrightVersion ?? null,
          matchCount: parsedErr.resolvedCount,
          visibleMatchCount: visibleMatchCountFromAria(aria, failingRoleName(selector)),
        })
      : null;

  const location = extractErrorLocation(error);
  const sourceLine = parseFailingSourceLine(input.testSource, location);
  // Computed up front so healed detection (below) can compare against it in
  // every rung, including the location match that doesn't otherwise need it.
  const failingSig = selector ? await locatorSignatureFromExpression(selector) : null;
  const method = selector ? locatorExpressionMethod(selector) : null;

  const renamed = findDiffRename(error, location, input.locatorBreaks);

  const finish = async (r: LocatorHealingResult): Promise<LocatorHealingResult> => {
    r.applicable = true;
    r.reason = null;
    r.narrowingSuggestion = narrowing;
    r.location = location;
    r.sourceLine = sourceLine;
    r.edit = buildHealEdit({
      location,
      sourceLine,
      failingMethod: r.failingLocator?.method ?? null,
      recommendedLocator: r.recommendation?.recommended?.locator ?? null,
      testSource: input.testSource ?? null,
      fallbackFilePath: input.filePath ?? null,
      literalReplacements: r.source === 'diff-rename' ? (renamed?.replacements ?? null) : null,
    });
    return r;
  };

  // Ladder 0: the run's own diff renamed the string this chain finds its element by.
  if (renamed) return finish(diffRenameResult(failingLocator, renamed));

  // Ladder 1: call-site location.
  if (location && snaps.length > 0) {
    const hit = snaps.find((s) => s.location === location) ?? snaps.find((s) => sameFileLine(s.location, location));
    if (hit) return finish(resolveStoredHit(failingLocator, hit, aria, 'prior-run'));
  }

  if (failingSig) {
    // Ladder 2: locator signature — survives line shifts; returns the first match.
    const hit = snaps.find((s) => s.usedArgsFp === failingSig && (!method || s.usedMethod === method));
    if (hit) return finish(resolveStoredHit(failingLocator, hit, aria, 'fingerprint'));

    // Ladder 2.5: cross-test — same signature captured by another test in the
    // project (freshest wins). Injected so this core needs no DB handle.
    if (findCrossTest) {
      const crossHit = await findCrossTest(failingSig, method);
      if (crossHit) return finish(resolveStoredHit(failingLocator, crossHit, aria, 'cross-test'));
    }
  }

  // Ladder 3: ARIA snapshot fallback.
  const ariaAlts = generateFromAriaSnapshot(aria, failingLocator);
  if (ariaAlts) {
    return finish(
      buildHealingResult(failingLocator, null, ariaAlts, 'aria-snapshot', null, null, {
        recommendFrom: ariaRecommendationPool(ariaAlts, failingLocator),
      }),
    );
  }
  return finish(buildHealingResult(failingLocator, null, null, 'none'));
}

/**
 * The run in which a heal recorded `applied` for the failure seen in
 * `failingRunId` at `location`, if one did: the stored outcome, never a later
 * recomputation.
 */
export function healedInRunFrom(
  applied: OutcomeRecord[],
  testCaseId: number,
  location: string | null,
  failingRunId: number | null,
): number | null {
  if (!location || failingRunId == null) return null;
  let best: number | null = null;
  for (const row of applied) {
    const details = row.details as LocatorHealDetails | null;
    if (row.subjectId !== testCaseId || row.outcome !== 'applied' || !details?.appliedRunId) continue;
    if (details.appliedRunId <= failingRunId || !sameFileLine(details.location, location)) continue;
    if (best == null || details.appliedRunId < best) best = details.appliedRunId;
  }
  return best;
}

/**
 * Stamp `healedInRunId` on healing results from the stored `locator-heal`
 * outcomes: the first run after the failing one whose code at the failing call
 * site used the recommended locator.
 */
async function stampStoredHealedRuns(
  db: DrizzleDB,
  cases: Array<{ result: LocatorHealingResult; testCaseId: number; failingRunId: number }>,
): Promise<void> {
  const candidates = cases.filter((c) => c.result.applicable && c.result.location);
  if (candidates.length === 0) return;
  const applied = await listOutcomes(db, {
    kind: 'locator-heal',
    subjectType: 'test-case',
    subjectIds: [...new Set(candidates.map((c) => c.testCaseId))],
    outcomes: ['applied'],
  });
  for (const c of candidates) {
    const healed = healedInRunFrom(applied, c.testCaseId, c.result.location ?? null, c.failingRunId);
    if (healed != null) c.result.healedInRunId = healed;
  }
}

/**
 * Find the freshest snapshot of the same locator signature captured by a
 * *different* test case in the same project — the cross-test healing ladder.
 * The project scope keeps suggestions on the same application; the signature
 * (method + ordered string literals) guarantees it is the same locator text.
 */
async function findCrossTestSnapshot(
  db: DrizzleDB,
  testCaseId: number,
  sig: string,
  method: string | null,
): Promise<LocatorSnapshotRow | null> {
  const rows = await db
    .select({ snap: locatorSnapshots })
    .from(locatorSnapshots)
    .innerJoin(testCases, eq(locatorSnapshots.testCaseId, testCases.id))
    .where(
      and(
        eq(testCases.projectId, sql`(select project_id from test_cases where id = ${testCaseId})`),
        eq(locatorSnapshots.usedArgsFp, sig),
        ne(locatorSnapshots.testCaseId, testCaseId),
        ...(method ? [eq(locatorSnapshots.usedMethod, method)] : []),
      ),
    )
    .orderBy(sql`${locatorSnapshots.lastSeenAt} desc`)
    .limit(1);
  return rows[0]?.snap ?? null;
}

/**
 * Batch variant: fetch locator healing for multiple test-run-case IDs in
 * two queries instead of N * 2. Used by the MCP `get_cluster` tool to avoid
 * N+1 overhead when attaching healing to affected cases.
 */
export async function getLocatorHealingBatch(
  db: DrizzleDB,
  testRunsCaseIds: number[],
): Promise<Map<number, LocatorHealingResult>> {
  const results = new Map<number, LocatorHealingResult>();
  if (testRunsCaseIds.length === 0) return results;

  // 1. Load all failing rows in one query, then coalesce payload-stored
  // aria/test-source content (one batched lookup for every referenced payload)
  const rawCaseRows = await db
    .select({
      id: testRunsCases.id,
      error: testRunsCases.error,
      testCaseId: testRunsCases.testCaseId,
      testRunId: testRunsCases.testRunId,
      ariaSnapshot: testRunsCases.ariaSnapshot,
      ariaSnapshotJson: testRunsCases.ariaSnapshotJson,
      testSource: testRunsCases.testSource,
      ariaSnapshotPayloadId: testRunsCases.ariaSnapshotPayloadId,
      ariaSnapshotJsonPayloadId: testRunsCases.ariaSnapshotJsonPayloadId,
      testSourcePayloadId: testRunsCases.testSourcePayloadId,
      filePath: testCases.filePath,
      playwrightVersion: testRuns.playwrightVersion,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(inArray(testRunsCases.id, testRunsCaseIds));

  const payloadContents = await resolveCasePayloadContents(
    db,
    rawCaseRows.flatMap((r) => [r.ariaSnapshotPayloadId, r.ariaSnapshotJsonPayloadId, r.testSourcePayloadId]),
  );
  const caseRows = rawCaseRows.map((r) => ({
    ...r,
    ariaSnapshot:
      (r.ariaSnapshotPayloadId != null ? payloadContents.get(r.ariaSnapshotPayloadId) : undefined) ?? r.ariaSnapshot,
    ariaSnapshotJson:
      (r.ariaSnapshotJsonPayloadId != null ? payloadContents.get(r.ariaSnapshotJsonPayloadId) : undefined) ??
      r.ariaSnapshotJson,
    testSource:
      (r.testSourcePayloadId != null ? payloadContents.get(r.testSourcePayloadId) : undefined) ?? r.testSource,
  }));

  // 2. Collect unique test case IDs and load all snapshots in one query
  const tcIds = [...new Set(caseRows.map((r) => r.testCaseId).filter(Boolean))];
  const allSnaps =
    tcIds.length > 0 ? await db.select().from(locatorSnapshots).where(inArray(locatorSnapshots.testCaseId, tcIds)) : [];

  // Bucket snapshots by testCaseId for fast lookup
  const snapsByTc = new Map<number, LocatorSnapshotRow[]>();
  for (const s of allSnaps) {
    const arr = snapsByTc.get(s.testCaseId);
    if (arr) arr.push(s);
    else snapsByTc.set(s.testCaseId, [s]);
  }

  const breaksByRun = await loadRunLocatorBreaks(db, [...new Set(caseRows.map((r) => r.testRunId))]);

  // 3. Run the shared ladder for each case (cross-test still queried per case,
  // but only when the cheaper location/signature rungs miss).
  for (const row of caseRows) {
    const snaps = snapsByTc.get(row.testCaseId) ?? [];
    results.set(
      row.id,
      await resolveHealingForCase(
        {
          error: row.error,
          ariaSnapshot: row.ariaSnapshot,
          ariaSnapshotJson: row.ariaSnapshotJson,
          playwrightVersion: row.playwrightVersion,
          testSource: row.testSource,
          filePath: row.filePath,
          locatorBreaks: breaksByRun.get(row.testRunId) ?? null,
        },
        snaps,
        row.testCaseId ? (sig, method) => findCrossTestSnapshot(db, row.testCaseId, sig, method) : null,
      ),
    );
  }
  await stampStoredHealedRuns(
    db,
    caseRows
      .filter((row) => row.testCaseId)
      .map((row) => ({ result: results.get(row.id)!, testCaseId: row.testCaseId, failingRunId: row.testRunId })),
  );

  return results;
}

/**
 * Compare two `file:line:col` locations ignoring the trailing column. The file
 * parts match on a path suffix at a `/` boundary, so the stored cwd-relative
 * capture location (`tests/x.spec.ts`) still matches an absolute path from an
 * error stack frame (`/repo/tests/x.spec.ts`).
 */
export function sameFileLine(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const [fileA, lineA] = splitFileLine(a);
  const [fileB, lineB] = splitFileLine(b);
  if (lineA !== lineB || !fileA || !fileB) return false;
  if (fileA === fileB) return true;
  return fileA.endsWith(`/${fileB}`) || fileB.endsWith(`/${fileA}`);
}

/** Split `file:line:col` into `[file, line]`, dropping the column. */
function splitFileLine(loc: string): [string, string] {
  const m = loc.match(/^(.*):(\d+):\d+$/) ?? loc.match(/^(.*):(\d+)$/);
  return m ? [m[1]!, m[2]!] : [loc, ''];
}

function parseAlternativesColumn(row: LocatorSnapshotRow): RankedLocator[] | null {
  try {
    return JSON.parse(row.alternatives) as RankedLocator[];
  } catch {
    return null;
  }
}

/**
 * Upsert locator snapshots for a batch of test cases, then purge rows for
 * locations no longer exercised. Shared by the server ingest path
 * (persist-run-cases) and the demo ingest mirror so the storage logic lives in
 * one place.
 *
 * Every location seen this run is preserved — including failed actions whose
 * placeholder carries a location but no element — so a locator that failed this
 * run keeps its prior-success row for the healing lookup.
 *
 * Stale-location purge is gated on each case's `purge` flag (set when its run
 * completed, i.e. passed): a failed/timed-out run can stop before later locators
 * execute, and those unreached locations must NOT be mistaken for "removed from
 * the test" and deleted. Rows are also deduped by (caseId, location) before the
 * upsert — the same call site acted on twice (a loop, or a page-object method
 * called more than once) captures one location repeatedly, and a single
 * multi-row `ON CONFLICT DO UPDATE` that targets the same key twice is rejected
 * by PostgreSQL ("cannot affect row a second time"); the latest capture wins.
 */
export async function upsertLocatorSnapshots(
  db: DrizzleDB,
  perCase: Array<{ caseId: number; snapshots: LocatorSnapshot[] | null | undefined; purge?: boolean }>,
  runId: number,
): Promise<void> {
  // Keyed by `${caseId}\x00${location}` so a repeated call site yields one row.
  const rowByKey = new Map<string, typeof locatorSnapshots.$inferInsert>();
  const seenByCase = new Map<number, Set<string>>();
  // Cases whose run completed (passed) — only these may purge stale locations.
  const purgeableCases = new Set<number>();

  for (const { caseId, snapshots, purge } of perCase) {
    // Tolerate a malformed/non-array payload field without failing run ingest.
    if (!Array.isArray(snapshots) || snapshots.length === 0) continue;

    const seen = seenByCase.get(caseId) ?? new Set<string>();
    for (const snap of snapshots) {
      if (snap.location) seen.add(snap.location);
    }
    if (seen.size > 0) seenByCase.set(caseId, seen);
    if (purge) purgeableCases.add(caseId);

    const captured = snapshots.filter((s) => s.element && s.location);
    const fps = await Promise.all(captured.map((s) => locatorSignature(s.used.method, s.used.args)));
    captured.forEach((snap, idx) => {
      rowByKey.set(`${caseId}\x00${snap.location}`, {
        testCaseId: caseId,
        location: snap.location!,
        usedMethod: snap.used.method,
        usedArgs: JSON.stringify(snap.used.args),
        usedArgsFp: fps[idx]!,
        elementTag: snap.element!.tagName,
        // rolePosition/ancestors must be folded in explicitly — this object is
        // the storage whitelist, so anything omitted here is silently dropped.
        elementAttrs: JSON.stringify({
          ...snap.element!.attributes,
          accessibleName: snap.element!.accessibleName,
          center: snap.element!.center,
          ...(snap.element!.rolePosition ? { rolePosition: snap.element!.rolePosition } : {}),
          ...(snap.element!.ancestors?.length ? { ancestors: snap.element!.ancestors } : {}),
        }),
        elementText: snap.element!.textContent,
        alternatives: JSON.stringify(snap.alternatives.slice(0, 10)),
        lastSeenRunId: runId,
        lastSeenAt: new Date(),
      });
    });
  }

  const rows = [...rowByKey.values()];
  if (rows.length > 0) {
    await db
      .insert(locatorSnapshots)
      .values(rows)
      .onConflictDoUpdate({
        target: [locatorSnapshots.testCaseId, locatorSnapshots.location],
        set: {
          usedMethod: sql`excluded.used_method`,
          usedArgs: sql`excluded.used_args`,
          usedArgsFp: sql`excluded.used_args_fp`,
          elementTag: sql`excluded.element_tag`,
          elementAttrs: sql`excluded.element_attrs`,
          elementText: sql`excluded.element_text`,
          alternatives: sql`excluded.alternatives`,
          lastSeenRunId: sql`excluded.last_seen_run_id`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      });
  }

  // Purge locations no longer exercised (locator removed/moved in the test) —
  // only for cases whose run completed, so a run that failed before reaching a
  // locator doesn't delete that locator's still-valid prior-success row.
  for (const [caseId, locs] of seenByCase) {
    if (!purgeableCases.has(caseId)) continue;
    await db
      .delete(locatorSnapshots)
      .where(and(eq(locatorSnapshots.testCaseId, caseId), notInArray(locatorSnapshots.location, [...locs])));
  }
}

/** Input for saving a user-confirmed pick from the dashboard's DOM-snapshot picker. */
export interface LocatorPickInput {
  /**
   * The failing locator as the healing panel displayed it — identity fallback
   * for the rare error whose stored text can't be re-parsed server-side.
   */
  failingLocator?: { method: string; args: Record<string, unknown> } | null;
  /** The alternative the user confirmed. */
  pickedLocator: RankedLocator;
  /** The picked element as probed inside the rendered DOM snapshot. */
  element?: Partial<ElementAttributes> | null;
}

export type LocatorPickSaveResult =
  | { status: 'ok'; associatedBy: 'location' | 'fingerprint' | 'new-call-site' }
  | { status: 'not-found' }
  | { status: 'not-persisted'; reason: 'no-identity' };

/**
 * Persist a user-confirmed locator pick against the failing call site so the
 * healing lookup surfaces it (`pickedByUser` wins the recommendation). Shared
 * by the `locator-pick` endpoint and the demo mirror.
 *
 * The failing locator's identity — call-site location and signature — is
 * re-derived from the stored error with the same helpers `getLocatorHealing`
 * uses, so the saved row is guaranteed to be found by the same ladder (location
 * first, then `usedArgsFp`). The client-provided `failingLocator` is only a
 * fallback when the error can't be re-parsed.
 *
 * An existing snapshot row keeps its captured element data (richer than the
 * snapshot-probe's) — the pick is merged to the front of `alternatives`. When
 * no row exists (the locator never passed), a new row is created from the pick;
 * `elementAttrs` follows the same storage-whitelist shape as
 * `upsertLocatorSnapshots`. Never silently drops a pick: when there is nothing
 * to key it on, the caller gets `not-persisted` to surface.
 */
export async function saveLocatorPick(
  db: DrizzleDB,
  testRunsCaseId: number,
  input: LocatorPickInput,
): Promise<LocatorPickSaveResult> {
  const rows = await db
    .select({ testCaseId: testRunsCases.testCaseId, error: testRunsCases.error })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, testRunsCaseId));
  const row = rows[0];
  if (!row) return { status: 'not-found' };
  if (!row.testCaseId) return { status: 'not-persisted', reason: 'no-identity' };

  // Same identity derivation as getLocatorHealing, so save and lookup agree.
  const error = row.error ?? '';
  const location = error ? extractErrorLocation(error) : null;
  const selector = error ? extractLeafSelector(error) : null;
  const method = (selector ? locatorExpressionMethod(selector) : null) ?? input.failingLocator?.method ?? null;
  const sig = selector
    ? await locatorSignatureFromExpression(selector)
    : input.failingLocator
      ? await locatorSignature(input.failingLocator.method, Object.values(input.failingLocator.args ?? {}))
      : null;
  if (!location && !sig) return { status: 'not-persisted', reason: 'no-identity' };

  const pick: RankedLocator = { ...input.pickedLocator, pickedByUser: true, pickedAt: new Date().toISOString() };
  const mergePick = (existing: RankedLocator[] | null): string =>
    JSON.stringify([pick, ...(existing ?? []).filter((a) => a.locator !== pick.locator)].slice(0, 10));

  const snaps = await db.select().from(locatorSnapshots).where(eq(locatorSnapshots.testCaseId, row.testCaseId));

  let associatedBy: 'location' | 'fingerprint' = 'location';
  let hit = location
    ? (snaps.find((s) => s.location === location) ?? snaps.find((s) => sameFileLine(s.location, location)))
    : undefined;
  if (!hit && sig) {
    hit = snaps.find((s) => s.usedArgsFp === sig && (!method || s.usedMethod === method));
    if (hit) associatedBy = 'fingerprint';
  }

  if (hit) {
    await db
      .update(locatorSnapshots)
      .set({ alternatives: mergePick(parseAlternativesColumn(hit)), lastSeenAt: new Date() })
      .where(eq(locatorSnapshots.id, hit.id));
    return { status: 'ok', associatedBy };
  }

  // No stored snapshot for this call site (the locator never passed) — create
  // one from the pick so the ladder finds it: by location when the error had
  // one, else by signature (the synthetic location only serves the unique key).
  const parsed = selector ? parseLocatorExpression(selector) : null;
  const el = input.element;
  await db
    .insert(locatorSnapshots)
    .values({
      testCaseId: row.testCaseId,
      location: location ?? `pick:${sig}`,
      usedMethod: method ?? pick.method,
      usedArgs: JSON.stringify(parsed?.args ?? input.failingLocator?.args ?? {}),
      usedArgsFp: sig ?? (await locatorSignature(method ?? pick.method, [])),
      elementTag: el?.tagName ?? 'unknown',
      // Same storage whitelist as upsertLocatorSnapshots — anything not folded
      // in here is dropped.
      elementAttrs: JSON.stringify({
        ...(el?.attributes ?? {}),
        accessibleName: el?.accessibleName ?? null,
        center: el?.center ?? null,
      }),
      elementText: el?.textContent ?? null,
      alternatives: JSON.stringify([pick]),
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [locatorSnapshots.testCaseId, locatorSnapshots.location],
      set: { alternatives: sql`excluded.alternatives`, lastSeenAt: sql`excluded.last_seen_at` },
    });
  return { status: 'ok', associatedBy: 'new-call-site' };
}
