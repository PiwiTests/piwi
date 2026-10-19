/**
 * Shared types for locator healing — the in-runtime capture + storage of
 * alternative locators for every element interaction.
 *
 * The single source of truth: the dashboard app re-exports these via
 * `#shared/locator-healing.types`, and the reporter bundles them at build time.
 */

/** A ranked alternative locator suggestion. */
export interface RankedLocator {
  locator: string;
  method: string;
  args: Record<string, unknown>;
  /** 0-100 stability score. data-testid=100, semantic CSS=35-40, hash-suffixed=10. */
  score: number;
  /**
   * True when a human confirmed this alternative in the reporter's
   * failure-time locator picker (`pickLocatorOnFailure`). A confirmed pick is
   * surfaced distinctly and preferred as the recommended fix.
   */
  pickedByUser?: boolean;
  /** When the pick was saved from the dashboard's snapshot picker, ISO 8601. */
  pickedAt?: string;
}

/**
 * A suggestion to narrow a strict-mode-ambiguous locator with `.visible()`:
 * when the failing locator matches several elements but only one of them is
 * visible, adding `.visible()` resolves the strict-mode violation without
 * changing the locator itself. Surfaced beside the replacement locators.
 */
export interface NarrowingSuggestion {
  /** The chain modifier to add before the action — `visible` today. */
  method: 'visible';
  /** How many elements the failing locator matched (the strict-mode count). */
  matchCount: number;
  /** How many of those were visible — always 1 when the suggestion is shown. */
  visibleCount: number;
}

/**
 * The single recommended fix, chosen from the stability-ranked alternatives so
 * it keeps the developer's original locator style where that style is stable
 * enough — a minimal, idiomatic edit. The full ranked menu stays available; this
 * just picks the one fix to surface as the "Top recommendation".
 */
export interface LocatorFixRecommendation {
  /** The recommended fix. Null only when there are no alternatives at all. */
  recommended: RankedLocator | null;
  /** The most stable alternative overall — surfaced so a sturdier (but different) choice stays visible. */
  durable: RankedLocator | null;
  /** True when `recommended` keeps the failing locator's method family (same style). */
  preservesConvention: boolean;
  /** True when `durable` is a different, sturdier option than `recommended`. */
  hasDurableAlternative: boolean;
  /** True when nothing cleared the stability floor — advise adding a `data-testid` to the app. */
  suggestAddTestId: boolean;
}

/**
 * Match counts for candidate selectors, probed against the live DOM at capture
 * time. A count > 1 marks the selector ambiguous (strict-mode violation).
 */
export interface SelectorCounts {
  testId?: number;
  id?: number;
  name?: number;
  classes?: Record<string, number>;
  /** How many elements share this element's role *and* exact accessible name (`getByRole(role, { name })` without `exact` also matches names that contain it). Absent when unknown (an older capture, or a probe run without the structural pass). */
  roleName?: number;
  /** Of the `roleName` matches, how many are visible (a laid-out box, or an `offsetParent`) — what `getByRole(role, { name }).visible()` would match. Absent when unknown. */
  visibleRoleName?: number;
  /** How many elements `getByText` would match on this element's text, counted no further than 2. Absent when unknown. */
  text?: number;
  /** How many elements share this element's `placeholder` — what `getByPlaceholder` would really match. Absent when unknown. */
  placeholder?: number;
  /** How many elements share this element's `alt` — what `getByAltText` would really match. Absent when unknown. */
  alt?: number;
  /** How many elements share this element's `title` — what `getByTitle` would really match. Absent when unknown. */
  title?: number;
}

/**
 * The element's position among same-role elements in the document at capture
 * time — a name-independent structural identity used to re-find a renamed
 * element on the failing page.
 */
export interface RolePosition {
  role: string;
  /** How many elements resolved to this role, document-wide. */
  count: number;
  /** The captured element's 0-based index among them, in document order. */
  index: number;
  /** For headings: how many same-role elements share this element's level. */
  levelCount?: number;
}

/**
 * An anchor-worthy ancestor of the captured element — one carrying a stable
 * hook (test id, id, explicit role, aria-label, or a landmark tag) that a
 * scoped alternative locator can chain from. Nearest ancestors first.
 */
export interface AncestorAnchor {
  tag: string;
  /** Hops from the element (1 = direct parent). */
  depth: number;
  testId: string | null;
  id: string | null;
  /** Explicit role attribute, if any. */
  role: string | null;
  ariaLabel: string | null;
  /** Same-role matches for the captured element within this ancestor. */
  scopedRoleCount?: number;
  /**
   * Matches for the captured element's text within this ancestor. A role-less
   * leaf (a price `<span>`, a status badge) has no role to scope, so this is
   * what tells a chain that resolves to one element from one that does not.
   */
  scopedTextCount?: number;
  /** Document-wide match count for this ancestor's own data-testid. */
  testIdCount?: number;
  /** Document-wide match count for this ancestor's own id. */
  idCount?: number;
  /** Document-wide count of elements resolving to this ancestor's landmark/explicit role. */
  roleCount?: number;
  /**
   * A stable non-testid `data-*` hook on this ancestor (`data-product="43"`,
   * `data-row-id="7"`). Many apps identify a repeated card or row this way and
   * nothing else, so without it the only locator left is one that matches every
   * card on the page.
   */
  dataAttr?: { name: string; value: string };
  /** Document-wide match count for `dataAttr` as an attribute selector. */
  dataAttrCount?: number;
  /**
   * Text inside this ancestor that tells it apart from its same-role siblings —
   * the product name in a card, the customer name in a table row. A repeated
   * container carries no unique hook of its own, so this is what makes
   * `getByRole('listitem').filter({ hasText: 'Keyboard' })` land on one of them.
   */
  filterText?: string;
  /** How many elements of this ancestor's role contain `filterText`. */
  filterRoleCount?: number;
}

/** Raw element attributes captured after a successful action. */
export interface ElementAttributes {
  tagName: string;
  attributes: Record<string, string | null>;
  /** Visible text, truncated to 80 chars. */
  textContent: string | null;
  /** Browser-computed accessible name from ariaSnapshot(). */
  accessibleName: string | null;
  /** Center point of the element's bounding box — spatial discriminator. */
  center: { x: number; y: number } | null;
  /** True when the element has an associated <label> — gates getByLabel. */
  hasLabel?: boolean;
  /** Text of the elements `aria-labelledby` points at, else of the first associated `<label>` — what names a form field. Absent when the probe did not read it. */
  labelText?: string | null;
  /** Live-page uniqueness probe results for candidate selectors. */
  selectorCounts?: SelectorCounts;
  /** Position among same-role elements — powers name-free and renamed-element healing. */
  rolePosition?: RolePosition | null;
  /** Anchor-worthy ancestors, nearest first — power ancestor-scoped alternatives. */
  ancestors?: AncestorAnchor[];
}

/** One captured element interaction (per locator call site). */
export interface LocatorSnapshot {
  /** The Playwright step location — unique, stable identity of this call site. */
  location: string | null;
  /** The locator the test code actually used. */
  used: {
    method: string;
    /** All args passed to the locator method. */
    args: unknown[];
    /** Original step title, for round-tripping. */
    raw: string;
  };
  /** Element attributes — null for gap entries (failed actions). */
  element: {
    tagName: string;
    attributes: Record<string, string | null>;
    textContent: string | null;
    accessibleName: string | null;
    center: { x: number; y: number } | null;
    /** Position among same-role elements at capture time (newer reporters only). */
    rolePosition?: RolePosition | null;
    /** Anchor-worthy ancestors, nearest first (newer reporters only). */
    ancestors?: AncestorAnchor[];
  } | null;
  /** Computed alternative locators, ranked by stability score (max 10). */
  alternatives: RankedLocator[];
}

/**
 * Where a healing lookup's alternatives came from, best first:
 * `diff-rename` (the change under test renamed the string the locator finds its
 * element by, and the same chain with the new string replaces it),
 * `prior-run` (exact call-site match against a pre-captured snapshot),
 * `fingerprint` (locator-signature match, survives line shifts),
 * `cross-test` (same locator signature captured by another test in the project),
 * `element-match` (element renamed/moved — fresh locators for its current identity),
 * `aria-snapshot` (derived from the failure-time ARIA snapshot only).
 */
export type LocatorHealingSource =
  | 'diff-rename'
  | 'prior-run'
  | 'element-match'
  | 'fingerprint'
  | 'cross-test'
  | 'aria-snapshot'
  | 'none';

/** The rename behind a `diff-rename` healing result: "`Pay now` became `Pay` in CheckoutButton.vue:14". */
interface DiffRenameEvidence {
  before: string;
  after: string;
  /** The changed application file, repository-relative. */
  file: string;
  /** Its line in the new file. */
  line: number;
}

/**
 * A ready-to-apply rewrite of the failing call site's source line, using the
 * recommended locator. Deterministic string rewrite of a single line — never
 * model output.
 */
export interface LocatorEdit {
  /** Call-site file path as captured (cwd-relative), when identified. */
  filePath: string | null;
  /** 1-based line the rewrite applies to. */
  line: number;
  /** The failing source line, unchanged (the `-` side). */
  oldLine: string;
  /** The rewritten source line (the `+` side). */
  newLine: string;
  /**
   * A unified diff for the change, or null when no file path was resolved.
   * Context-bearing (applies with a plain `git apply`) when the captured source
   * snippet supplied neighboring lines; otherwise context-free, which needs
   * `git apply --unidiff-zero`.
   */
  unifiedDiff: string | null;
}

/**
 * Result of a healing lookup for one failing test-run case. Single source of
 * truth for the API payload shape — the server handler, MCP tools, AI context
 * and the dashboard panel all import this.
 */
export interface LocatorHealingResult {
  /**
   * Whether a replacement locator can address this failure at all. False when
   * the locator resolved and the action or assertion failed afterwards, when the
   * error is a navigation failure, or when the error names no locator — the
   * alternative lists are then empty and `reason` says why in one sentence.
   */
  applicable?: boolean;
  /** One sentence explaining an `applicable: false` result; null otherwise. */
  reason?: string | null;
  failingLocator: { method: string; args: Record<string, unknown> } | null;
  fromPriorSuccess: RankedLocator[] | null;
  /**
   * Fresh locators generated from the element's *current* identity, when the
   * pre-captured locator no longer matches the live page (renamed/moved element).
   */
  fromElementMatch: RankedLocator[] | null;
  fromAriaSnapshot: RankedLocator[] | null;
  /**
   * The chain rewritten with the new string, when the run's own diff renamed
   * the string the failing locator finds its element by (`diff-rename`).
   */
  fromDiffRename?: RankedLocator[] | null;
  /** What the run's diff changed, for a `diff-rename` result: shown as its evidence. */
  diffRename?: DiffRenameEvidence | null;
  source: LocatorHealingSource;
  /**
   * The single recommended fix — convention-preserving where possible — chosen
   * from the active alternative list. Null when no alternatives are available,
   * or when none of them is a fix (each looks stale, or finds the element the
   * failing locator already names).
   */
  recommendation: LocatorFixRecommendation | null;
  /**
   * When the failure is a strict-mode violation and only one of the matches is
   * visible, a suggestion to add `.visible()` beside the replacement locators.
   * Gated on the run's stored Playwright being 1.63 or later. Null otherwise.
   */
  narrowingSuggestion?: NarrowingSuggestion | null;
  /**
   * When the alternatives come from a stored snapshot (`prior-run` /
   * `fingerprint` / `cross-test`), the time that snapshot was last captured —
   * lets consumers judge freshness. Null otherwise.
   */
  capturedAt: string | null;
  /**
   * True when the stored element's accessible name is provably gone from the
   * failing page's ARIA snapshot but no confident rename match was found: the
   * name-derived alternatives in `fromPriorSuccess` (and the failing locator
   * itself) most likely no longer match. The recommendation already excludes
   * them; `fromAriaSnapshot` carries supplementary candidates from the failing
   * page.
   */
  priorNameMayBeStale?: boolean;
  /**
   * The failing locator's source call site (`file:line:col`) from the error
   * stack, when identified — the exact place a suggested fix would be applied.
   */
  location?: string | null;
  /**
   * The failing test's source line — number + text — parsed from the captured
   * `testSource` snippet, when available. Powers the panel's "suggested edit"
   * (rewriting this line's locator) and gives an agent the line to edit.
   */
  sourceLine?: { line: number; text: string } | null;
  /**
   * Closed loop: when the recommended fix now passes at this call site — a later
   * run captured the recommendation's locator signature at the same location —
   * that run's id. Lets the panel confirm "healed in run #N". Null when not yet
   * adopted, or when the recommendation is a chained anchor (its re-captured leaf
   * signature can't be reconstructed to match).
   */
  healedInRunId?: number | null;
  /**
   * The recommended fix as a concrete, ready-to-apply edit to the failing source
   * line — old line, rewritten line, and a git-applyable unified diff. Null when
   * there is no captured source line, no recommendation, or the rewrite would be
   * a no-op. Populated only by the server (it needs the parsed call site).
   */
  edit?: LocatorEdit | null;
}
