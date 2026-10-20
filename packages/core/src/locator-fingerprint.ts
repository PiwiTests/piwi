/**
 * Element-fingerprint matching — the "element changed" case of locator healing.
 *
 * The pre-captured alternatives describe the *old* element, so when an element
 * is renamed/moved/replaced they all point at something that no longer exists.
 * These pure helpers fingerprint the elements visible in the failure-time ARIA
 * snapshot, find the current element that the old one most likely became, and
 * generate *fresh* locators from it — a real "new locator from the new page".
 *
 * The single source of truth for both the server lookup / demo router (via
 * `#shared/locator-fingerprint`) and the reporter's runtime annotation (which
 * bundles this at build time).
 */
import type { RankedLocator, RolePosition } from './locator-healing-types';
import { quoteJsString } from './locator-chain';

/** One element parsed out of an ariaSnapshot() dump: its role and accessible name. */
export interface AriaCandidate {
  role: string;
  name: string | null;
  /** Heading level parsed from a `[level=N]` marker, null when absent. */
  level: number | null;
}

/** Identity of a captured element, used to find where it went on the current page. */
export interface ElementFingerprint {
  role: string | null;
  /** Accessible name / visible text at capture time. */
  name: string | null;
  /** Heading level of the captured element, when known. */
  level?: number | null;
  /** Position among same-role elements at capture time, when known. */
  rolePosition?: RolePosition | null;
}

export interface ElementMatch {
  candidate: AriaCandidate;
  /** 0-1 — how confident the match is (1 = unique same-role element). */
  confidence: number;
}

/** Score band for element-match locators: below prior-success (≤100) but above the convention floor (50). */
const ELEMENT_MATCH_SCORES = { role: 60, text: 55, label: 50 } as const;

/** A renamed element is considered "still present" when a same-role candidate keeps a near-identical name. */
const PRESENT_SIMILARITY = 0.8;
/** Minimum name similarity to accept a match when several same-role candidates compete. */
const MATCH_SIMILARITY = 0.2;

/**
 * Roles whose accessible name comes from their visible text — `getByText` is
 * viable. The single source of truth shared by fresh-locator generation
 * (`freshLocatorsFromCandidate`) and the ARIA-fallback healing
 * (`generateFromAriaSnapshot`), both below: both emit a `getByText` alternative
 * for these roles, whose visible text content is exactly what `getByText`
 * matches.
 */
const TEXT_CONTENT_ROLES = new Set([
  'button',
  'link',
  'heading',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'cell',
  'columnheader',
  'rowheader',
  'gridcell',
  'treeitem',
  'listitem',
  'checkbox',
  'radio',
  'switch',
]);

/** Roles that are form fields — their name comes from a `<label>`, so `getByLabel` is viable. */
const FORM_FIELD_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider']);

/**
 * Parse a Playwright `ariaSnapshot()` dump into role/name candidates.
 *
 * The format is YAML-ish, one node per line, e.g.:
 *   - button "Open page"
 *   - heading "Welcome" [level=1]
 *   - textbox "Email"
 *   - generic
 * Lines with no role, or the structural `generic`/`group` wrappers with no name,
 * carry no locator value and are skipped.
 */
export function parseAriaCandidates(ariaSnapshot: string | null | undefined): AriaCandidate[] {
  if (!ariaSnapshot) return [];
  const out: AriaCandidate[] = [];
  for (const line of ariaSnapshot.split('\n')) {
    const m = line.match(/^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/i);
    if (!m) continue;
    const role = m[1]!;
    const name = m[2] != null ? m[2].replace(/\\(.)/g, '$1') : null;
    // Drop nameless structural wrappers — they can't produce a useful locator.
    if (!name && (role === 'generic' || role === 'group' || role === 'list' || role === 'paragraph')) continue;
    // Heading level rides after the name as `[level=N]` (other bracketed
    // markers like `[ref=eN]` are ignored). Scan only past the matched part so
    // brackets inside the quoted name can't fake a level.
    const levelMatch = line.slice(m[0].length).match(/\[level=(\d+)\]/);
    const level = levelMatch ? Number(levelMatch[1]) : null;
    out.push({ role, name, level });
  }
  return out;
}

/**
 * Token-set (Dice) similarity between two short labels, 0-1. Case- and
 * punctuation-insensitive, so "Go to page" vs "Open page" share the "page"
 * token. Two empty strings score 1; one empty scores 0.
 */
export function textSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const tok = (s: string | null | undefined): Set<string> =>
    new Set(
      (s ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter(Boolean),
    );
  const sa = tok(a);
  const sb = tok(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const t of sa) if (sb.has(t)) common++;
  return (2 * common) / (sa.size + sb.size);
}

/**
 * Function words of three letters or more that relate two labels by accident
 * ("Add to your cart" and "Update your profile" share "your"), in English and
 * French. Shorter words ("to", "of", "de") are dropped by their length.
 */
const FUNCTION_WORDS = new Set(
  'the and for with from your you our this that les des une pour avec par sur aux dans vos votre nos notre'.split(' '),
);

/**
 * The words of a label that carry its meaning, lowercased. The label is split
 * on anything but letters and digits and where a lowercase letter meets an
 * uppercase one (a test id `submitOrder` reads as "submit order"); words of
 * three letters or more that are not function words are kept. A label with no
 * such word keeps all its words ("OK").
 */
function significantWords(text: string | null | undefined): Set<string> {
  const all = (text ?? '')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const meaningful = all.filter((w) => w.length >= 3 && !FUNCTION_WORDS.has(w));
  return new Set(meaningful.length > 0 ? meaningful : all);
}

/**
 * `textSimilarity` over the significant words of each label, so two labels
 * that share only short or function words ("Go to cart", "Back to top") score 0.
 * The measure every "is this element related to that name" decision uses.
 */
export function significantWordSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const sa = significantWords(a);
  const sb = significantWords(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  return (2 * common) / (sa.size + sb.size);
}

/** True when an element with this fingerprint is still present among the candidates (so it was NOT renamed). */
export function fingerprintPresent(fp: ElementFingerprint, candidates: AriaCandidate[]): boolean {
  if (!fp.name) return false; // no name to compare — can't confirm presence
  return candidates.some(
    (c) => (!fp.role || c.role === fp.role) && textSimilarity(c.name, fp.name) >= PRESENT_SIMILARITY,
  );
}

/**
 * Find the current-page candidate a renamed element most likely became.
 *
 * Restricts to the same role (the sturdiest cross-rename signal), narrows
 * headings to the captured `[level=N]` when candidates share it, then:
 *  - a single remaining candidate is a confident match even if the name changed
 *    completely (the canonical "button text changed" case);
 *  - with several, the best name-similarity wins, and must clear a small floor
 *    so we don't emit a noisy guess; short and function words do not count
 *    (`significantWordSimilarity`), so a shared "to" is no match;
 *  - on a total rename (no shared tokens), the element at the captured
 *    document-order index among same-role elements is used as a last resort —
 *    only when the same-role count is unchanged since capture, so DOM-vs-ARIA
 *    counting discrepancies (hidden elements, role approximation) disqualify
 *    the signal instead of mismatching.
 * Returns null when nothing is confident enough.
 */
export function matchRenamedElement(fp: ElementFingerprint, candidates: AriaCandidate[]): ElementMatch | null {
  if (candidates.length === 0) return null;

  const sameRole = fp.role ? candidates.filter((c) => c.role === fp.role) : candidates;
  if (sameRole.length === 0) return null;

  let pool = sameRole;
  if (fp.level != null) {
    const sameLevel = sameRole.filter((c) => c.level === fp.level);
    // Fall back to all same-role candidates when none share the level — the
    // rename may have changed the level too (h2 → h3).
    if (sameLevel.length > 0) pool = sameLevel;
  }

  if (pool.length === 1) {
    return { candidate: pool[0]!, confidence: 0.7 };
  }

  let best: AriaCandidate | null = null;
  let bestScore = -1;
  for (const c of pool) {
    const s = significantWordSimilarity(c.name, fp.name);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (best && bestScore >= MATCH_SIMILARITY) return { candidate: best, confidence: bestScore };

  // Positional tiebreak over the full same-role pool (rolePosition.count was
  // measured against all same-role elements, not one heading level).
  const pos = fp.rolePosition;
  if (pos && fp.role && pos.role === fp.role && sameRole.length >= 2 && sameRole.length === pos.count) {
    const byIndex = sameRole[pos.index];
    if (byIndex) return { candidate: byIndex, confidence: 0.5 };
  }

  return null;
}

/**
 * Generate fresh locator suggestions from a matched current-page candidate,
 * scored in the element-match band (below prior-success, above the convention
 * floor so the same-style fix can still be recommended).
 */
export function freshLocatorsFromCandidate(c: AriaCandidate): RankedLocator[] {
  const out: RankedLocator[] = [];
  const name = c.name;
  if (!name) return out;

  out.push(
    c.level != null
      ? {
          locator: `getByRole(${quoteJsString(c.role)}, { name: ${quoteJsString(name)}, level: ${c.level} })`,
          method: 'getByRole',
          args: { role: c.role, name, level: c.level },
          score: ELEMENT_MATCH_SCORES.role,
        }
      : {
          locator: `getByRole(${quoteJsString(c.role)}, { name: ${quoteJsString(name)} })`,
          method: 'getByRole',
          args: { role: c.role, name },
          score: ELEMENT_MATCH_SCORES.role,
        },
  );

  if (TEXT_CONTENT_ROLES.has(c.role)) {
    out.push({
      locator: `getByText(${quoteJsString(name)})`,
      method: 'getByText',
      args: { text: name },
      score: ELEMENT_MATCH_SCORES.text,
    });
  } else if (FORM_FIELD_ROLES.has(c.role)) {
    out.push({
      locator: `getByLabel(${quoteJsString(name)})`,
      method: 'getByLabel',
      args: { label: name },
      score: ELEMENT_MATCH_SCORES.label,
    });
  }

  return out;
}

// ── Page-wide ARIA fallback generator ────────────────────────────────────────
//
// `generateFromAriaSnapshot` and `freshLocatorsFromCandidate` (above) both turn
// ARIA candidates into ranked getByRole/getByText/getByLabel locators, but they
// serve different jobs and so score on different regimes — kept side by side so
// the distinction stays legible:
//   • freshLocatorsFromCandidate scores ONE candidate already matched to the
//     failing element (element-match healing) in a FIXED band (role 60 / text 55
//     / label 50): confidence comes from the match, not the text.
//   • generateFromAriaSnapshot is the last-resort fallback with NO matched
//     element — it keeps only the candidates RELATED to the failing locator
//     (a shared significant word, or the role it named) and ranks them by
//     relevance: base 40 + word overlap (0–25) + 5 for the failing role, with
//     tree order breaking ties (later first: content sits after the sidebar).

/** Score bonus of a candidate with the role the failing `getByRole` named. */
const SAME_ROLE_BONUS = 5;

/** The most alternatives the ARIA fallback returns. */
const ARIA_FALLBACK_LIMIT = 8;

/**
 * Generate alternatives from an ARIA snapshot for a failing locator — the
 * fallback used when no prior snapshot or element match exists. With no
 * element to start from, a candidate is kept only when it relates to the
 * failing locator:
 * 1. its accessible name shares a significant word with the failing text;
 * 2. it is the one named candidate with the role the failing `getByRole`
 *    named, whatever its name (the element match's lone same-role rule);
 * 3. when the failing locator has no text, it has the role it named.
 * A locator with neither text nor role (a CSS selector) gets no alternative.
 * Each kept candidate emits `getByRole`, plus `getByText` for text-bearing
 * roles or `getByLabel` for fields.
 */
export function generateFromAriaSnapshot(
  ariaSnapshot: string | null,
  failingLocator: { method: string; args: Record<string, unknown> } | null,
): RankedLocator[] | null {
  if (!ariaSnapshot || !failingLocator) return null;
  const { role: failingRole, text: failingText } = failingTarget(failingLocator);
  if (!failingRole && !failingText) return null;

  const candidates = parseAriaCandidates(ariaSnapshot);
  const sameRoleCount = failingRole ? candidates.filter((c) => c.name && c.role === failingRole).length : 0;

  // Every alternative with its candidate's place in tree order, the tiebreak.
  const ranked: Array<{ alt: RankedLocator; order: number }> = [];
  for (let order = 0; order < candidates.length; order++) {
    const { role, name, level } = candidates[order]!;
    if (!name) continue;

    const sameRole = role === failingRole;
    const overlap = failingText ? significantWordSimilarity(failingText, name) : 0;
    const related = failingText ? overlap > 0 || (sameRole && sameRoleCount === 1) : sameRole;
    if (!related) continue;

    const score = 40 + Math.round(overlap * 25) + (sameRole ? SAME_ROLE_BONUS : 0);
    const add = (alt: RankedLocator) => ranked.push({ alt, order });

    add(
      level != null
        ? {
            locator: `getByRole(${quoteJsString(role)}, { name: ${quoteJsString(name)}, level: ${level} })`,
            method: 'getByRole',
            args: { role, name, level },
            score,
          }
        : {
            locator: `getByRole(${quoteJsString(role)}, { name: ${quoteJsString(name)} })`,
            method: 'getByRole',
            args: { role, name },
            score,
          },
    );

    // getByText for roles whose visible text `getByText` inspects.
    if (TEXT_CONTENT_ROLES.has(role)) {
      add({
        locator: `getByText(${quoteJsString(name)})`,
        method: 'getByText',
        args: { text: name },
        score: score - 5, // slightly below the role-based locator
      });
    }

    if (['textbox', 'combobox', 'searchbox'].includes(role)) {
      add({
        locator: `getByLabel(${quoteJsString(name)})`,
        method: 'getByLabel',
        args: { label: name },
        score: score - 5,
      });
    }
  }

  ranked.sort((a, b) => b.alt.score - a.alt.score || b.order - a.order);
  const alts: RankedLocator[] = [];
  const seen = new Set<string>();
  for (const { alt } of ranked) {
    if (seen.has(alt.locator)) continue;
    seen.add(alt.locator);
    alts.push(alt);
    if (alts.length === ARIA_FALLBACK_LIMIT) break;
  }
  return alts.length > 0 ? alts : null;
}

/**
 * What a failing locator searched for: the role its `getByRole` named, and its
 * text — the text, label, placeholder, alt text, title or accessible name it
 * matched by, or else its test id, which often spells the element's purpose
 * (`submit-order`).
 */
function failingTarget(locator: { method: string; args: Record<string, unknown> }): {
  role: string | null;
  text: string | null;
} {
  const a = locator.args;
  const role = locator.method === 'getByRole' && typeof a.role === 'string' ? a.role : null;
  const raw = a.text ?? a.label ?? a.placeholder ?? a.alt ?? a.title ?? a.name ?? a.testId;
  const text = typeof raw === 'string' && /[\p{L}\p{N}]/u.test(raw) ? raw : null;
  return { role, text };
}

/**
 * Why an element match did or didn't produce fresh locators. `no-match` with a
 * named fingerprint is the "provably stale" signal: the old identity is gone
 * from the failing page but nothing confident replaced it, so the stored
 * name-derived alternatives are almost certainly broken too.
 */
type ElementMatchStatus = 'no-fingerprint' | 'no-aria' | 'no-candidates' | 'unchanged' | 'matched' | 'no-match';

export interface ElementMatchOutcome {
  status: ElementMatchStatus;
  /** Fresh locators for the matched candidate — non-null only for `matched`. */
  fresh: RankedLocator[] | null;
}

/**
 * End-to-end element match: given the fingerprint of an element whose locator
 * broke and the current failure-time ARIA snapshot, report whether the element
 * is unchanged, was confidently re-found under a new identity (with fresh
 * locators for it), or is gone without a confident replacement.
 */
export function elementMatchOutcome(
  fp: ElementFingerprint,
  ariaSnapshot: string | null | undefined,
): ElementMatchOutcome {
  if (!fp.role && !fp.name) return { status: 'no-fingerprint', fresh: null };
  if (!ariaSnapshot) return { status: 'no-aria', fresh: null };
  const candidates = parseAriaCandidates(ariaSnapshot);
  if (candidates.length === 0) return { status: 'no-candidates', fresh: null };

  // Element still on the page under the same identity → not a rename.
  if (fingerprintPresent(fp, candidates)) return { status: 'unchanged', fresh: null };

  const match = matchRenamedElement(fp, candidates);
  const fresh = match ? freshLocatorsFromCandidate(match.candidate) : [];
  if (fresh.length > 0) return { status: 'matched', fresh };
  return { status: 'no-match', fresh: null };
}
