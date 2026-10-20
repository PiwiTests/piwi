import * as path from 'node:path';
import { locatorCallValues, parseLeafLocatorCall } from '@piwitests/core/locator-chain';
import { readLocatorHeader, stripAnsi } from '@piwitests/core/error-parse';
import type { Page, TestInfo } from '@playwright/test';
import {
  installPickerOverlay,
  showAnchorPicker,
  showPickerChoices,
  generateAnchoredAlternatives,
  mergeCandidates,
  type PickedAnchorInfo,
  type PickedLeafInfo,
  type PickerOverlayArg,
  type ProbeArg,
  type ProbedAttrs,
} from '@piwitests/picker-dom';
import {
  approximateAccessibleName,
  generateAlternatives,
  headingLevel,
  renderFailing,
  resolveAriaRole,
  type FailedLocatorInfo,
  type LocatorSnapshot,
  type RankedLocator,
} from './locator-healing.js';

/**
 * Failure-time locator picker: when enabled (opt-in via the
 * `pickLocatorOnFailure` reporter option / `PIWI_PICK_LOCATOR_ON_FAIL`), a
 * test whose locator action failed gets a picker overlay injected into the
 * still-open page. The flow is guided:
 *
 *  1. **Element** — hover highlights, a click picks. The pick snaps to the
 *     nearest actionable ancestor (a click on the `<span>` inside a button
 *     picks the button), and ↑/↓ walk the DOM tree before the click commits.
 *  2. **Anchors** — the element's ancestors are listed; the human can bless
 *     one or more *stable parents* to scope the locator to, with a live
 *     "matches N" count for the current selection against the failing page.
 *  3. **Confirm** — ranked replacement locators (standard generation merged
 *     with the anchor-scoped candidates) are listed; the human confirms one.
 *
 * The confirmed pick is folded into the failing call site's locator snapshot
 * (so it rides the normal `piwi-locators` wire into the dashboard's healing
 * panel) and attached as `piwi-user-pick` plus a report annotation.
 *
 * Gated exactly like failure-time inspection (`inspect-on-failure.ts`):
 * headed browser, never CI, final attempt only.
 *
 * The overlay steps themselves (`installPickerOverlay`, `showAnchorPicker`,
 * `showPickerChoices`) and the anchor-alternative math live in
 * `@piwitests/picker-dom`, shared with the dashboard's snapshot picker.
 * Re-exported here so existing importers keep importing them from this module.
 */
export { installPickerOverlay, showAnchorPicker, showPickerChoices, generateAnchoredAlternatives, mergeCandidates };
export type { PickedAnchorInfo, PickedLeafInfo };

/**
 * The probe dependency, passed in by the capture fixture to avoid an import
 * cycle. `fn` is the fixture's in-page element probe (`probeElementAttrs`);
 * `el` is a browser-side element, hence `any` (no DOM lib in this package).
 */
export interface PickerProbe {
  fn: (el: any, arg: ProbeArg) => ProbedAttrs;
  arg: ProbeArg;
}

/** A confirmed pick — everything the fixture records about the human's choice. */
export interface UserPickResult {
  /**
   * The locator this pick replaces. Null when the overlay was opened purely to
   * inspect (`inspectOnFailure` with no identifiable failing locator) — the
   * pick still yields alternatives, but there is nothing to write back to.
   */
  failing: {
    method: string;
    args: unknown[];
    /** The failed locator rendered as source, e.g. `getByText('Pay now')`. */
    rendered: string;
    /** Test call site (`file:line:col`) of the failed action, when captured. */
    location: string | null;
  } | null;
  /** The alternative the human confirmed (also first in `alternatives`). */
  picked: RankedLocator;
  /** Full ranked list for the picked element, the confirmed pick first. */
  alternatives: RankedLocator[];
  /** Wire-shaped element snapshot of the picked element. */
  element: NonNullable<LocatorSnapshot['element']>;
  /** Stable parents the human blessed in the anchor step, when any. */
  anchors?: PickedAnchorInfo[];
}

// ── Deriving the failing locator from an assertion error ─────────────────────
// A locator *action* that throws is captured with its call site (see the
// fixture proxy). An `expect(locator).toBeVisible()` assertion is not an action,
// so nothing is captured — but Playwright's error still names the locator
// (`Locator: …`) and its call site, which is enough to run the picker.

/**
 * Parse a Playwright locator expression into `{ method, args }` for its leaf —
 * the last locating call, which identifies the resolved element, mirroring the
 * server's `extractLeafSelector`. Exported for tests.
 */
export function parseLeafLocatorExpression(rawExpr: string): { method: string; args: unknown[] } | null {
  const leaf = parseLeafLocatorCall(rawExpr);
  return leaf ? { method: leaf.method, args: locatorCallValues(leaf) } : null;
}

/**
 * Derive the failing locator + call site from a test's error(s) when no locator
 * action was captured (an `expect(...)` assertion failure). Reads the
 * `Locator: …` line Playwright prints and the error's own call location,
 * normalized cwd-relative to match captured snapshot locations. Returns null
 * when no locator can be identified. Exported for tests.
 */
export function deriveFailedLocator(testInfo: TestInfo): FailedLocatorInfo | null {
  const info = testInfo as unknown as {
    errors?: Array<{ message?: string; stack?: string; location?: { file: string; line: number; column: number } }>;
    error?: { message?: string; stack?: string; location?: { file: string; line: number; column: number } };
  };
  const errors = info.errors && info.errors.length > 0 ? info.errors : info.error ? [info.error] : [];
  for (const err of errors) {
    const header = readLocatorHeader(stripAnsi(`${err.message ?? ''}\n${err.stack ?? ''}`));
    if (!header) continue;
    const parsed = parseLeafLocatorExpression(header);
    if (!parsed) continue;
    const loc = err.location;
    const location = loc
      ? `${path.relative(process.cwd(), loc.file).split(path.sep).join('/')}:${loc.line}:${loc.column}`
      : null;
    return { method: parsed.method, args: parsed.args, location };
  }
  return null;
}

/** Best-effort in-page cleanup of every picker artifact. */
async function cleanupPicker(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const g = globalThis as any;
      if (typeof g.__piwiPickCleanup === 'function') g.__piwiPickCleanup();
      if (typeof g.__piwiAnchorCleanup === 'function') g.__piwiAnchorCleanup();
      delete g.__piwiPickCleanup;
      delete g.__piwiAnchorCleanup;
      delete g.__piwiPickState;
      delete g.__piwiPickChoice;
      delete g.__piwiPickedElement;
      delete g.__piwiAnchorState;
      delete g.__piwiPickAnchors;
      delete g.__piwiPickChainCount;
    });
  } catch {
    // The page may be gone — nothing left to clean.
  }
}

/** What the element → anchors → confirm flow yields: the confirmed locator, its alternatives and the element. */
export type PickedLocator = Omit<UserPickResult, 'failing'>;

/**
 * Run the element → anchors → confirm flow on a live page: element pick (snap
 * + tree-walk), optional stable-parent anchoring with live match counts, ranked
 * candidates (standard generation merged with anchor-scoped chains), and a
 * final confirmation. `failing` is the locator the pick replaces, rendered, for
 * the overlay's headings; null to pick any element. Returns null when the
 * human skips or no locator could be generated; throws when the page breaks.
 */
export async function pickLocator(
  page: Page,
  probe: PickerProbe,
  failing: string | null,
): Promise<PickedLocator | null> {
  try {
    const overlayArg: PickerOverlayArg = { transport: 'global', failing };
    await page.evaluate(installPickerOverlay, overlayArg);
    await page.waitForFunction(() => (globalThis as any).__piwiPickState !== undefined, undefined, {
      timeout: 0,
      polling: 250,
    });
    const state = (await page.evaluate(() => (globalThis as any).__piwiPickState)) as string;
    if (state !== 'picked') return null;

    const handle = await page.evaluateHandle(() => (globalThis as any).__piwiPickedElement);
    const attrs = (await (handle as any).evaluate(probe.fn, probe.arg)) as ProbedAttrs;
    await handle.dispose();

    const accessibleName = approximateAccessibleName({ ...attrs, accessibleName: null });
    const role = resolveAriaRole({ ...attrs, accessibleName });
    const level = headingLevel({ ...attrs, accessibleName }, role);

    // Anchor step — only when the leaf has a role (anchor-scoped chains are
    // role-leaf locators, matching the heuristic chain shapes).
    let anchors: PickedAnchorInfo[] = [];
    let chainLeafCount: number | undefined;
    if (role) {
      const probeArg = probe.arg;
      await page.evaluate(showAnchorPicker, {
        tagRoles: probeArg.tagRoles ?? {},
        inputRoles: probeArg.inputRoles ?? {},
        roleSources: probeArg.roleSources ?? '',
        leafRole: role,
        leafLevel: level,
        leafTestId: attrs.attributes['data-testid'] ?? null,
      });
      await page.waitForFunction(() => (globalThis as any).__piwiAnchorState !== undefined, undefined, {
        timeout: 0,
        polling: 250,
      });
      const anchorResult = (await page.evaluate(() => {
        const g = globalThis as any;
        return { state: g.__piwiAnchorState, anchors: g.__piwiPickAnchors ?? [], chainCount: g.__piwiPickChainCount };
      })) as { state: string; anchors: PickedAnchorInfo[]; chainCount?: number };
      if (anchorResult.state === 'done' && anchorResult.anchors.length > 0) {
        anchors = anchorResult.anchors;
        chainLeafCount = anchorResult.chainCount;
      }
    }

    const ranked = mergeCandidates(
      generateAlternatives({ ...attrs, accessibleName }),
      generateAnchoredAlternatives({ role, level }, anchors, chainLeafCount),
    );
    if (ranked.length === 0) {
      console.log('[piwi] No stable locator could be generated for the picked element — nothing recorded.');
      return null;
    }

    await page.evaluate(showPickerChoices, {
      failing,
      choices: ranked.map((r) => ({ locator: r.locator, score: r.score })),
    });
    await page.waitForFunction(() => (globalThis as any).__piwiPickChoice !== undefined, undefined, {
      timeout: 0,
      polling: 250,
    });
    const choice = (await page.evaluate(() => (globalThis as any).__piwiPickChoice)) as number;
    if (typeof choice !== 'number' || choice < 0 || choice >= ranked.length) return null;

    const picked: RankedLocator = { ...ranked[choice]!, pickedByUser: true };
    return {
      picked,
      alternatives: [picked, ...ranked.filter((_, i) => i !== choice)],
      element: {
        tagName: attrs.tagName,
        attributes: attrs.attributes,
        textContent: attrs.textContent,
        accessibleName,
        center: attrs.center,
        ...(attrs.rolePosition ? { rolePosition: attrs.rolePosition } : {}),
        ...(attrs.ancestors && attrs.ancestors.length > 0 ? { ancestors: attrs.ancestors } : {}),
      },
      ...(anchors.length > 0 ? { anchors } : {}),
    };
  } finally {
    await cleanupPicker(page);
  }
}

/**
 * Drive the full pick flow on the failing page (`pickLocator`), the test
 * timeout lifted while waiting. Returns null when skipped or when anything
 * breaks — the picker must never mask the test's own failure.
 */
export async function runLocatorPicker(
  page: Page,
  testInfo: TestInfo,
  failed: FailedLocatorInfo | null,
  probe: PickerProbe,
): Promise<UserPickResult | null> {
  try {
    testInfo.setTimeout(0);
    const rendered = failed ? renderFailing(failed) : null;
    console.log(
      `\n[piwi] "${testInfo.title}" ${testInfo.status} — ${rendered ? 'locator picker' : 'inspector'} open in the ` +
        `browser: ${
          rendered
            ? `click the element that should replace ${rendered}`
            : 'click any element to generate ' + 'locators for it'
        } (↑/↓ to select a parent/child, Esc to skip).`,
    );

    const pick = await pickLocator(page, probe, rendered);
    if (!pick) return null;

    const location = failed?.location ?? null;
    console.log(
      failed
        ? `[piwi] Replacement picked for ${rendered}${location ? ` at ${location}` : ''}:\n[piwi]   ${pick.picked.locator}`
        : `[piwi] Locator picked while inspecting:\n[piwi]   ${pick.picked.locator}`,
    );
    return {
      failing: failed ? { method: failed.method, args: failed.args, rendered: rendered!, location } : null,
      ...pick,
    };
  } catch {
    return null;
  }
}

/**
 * Fold a confirmed pick into the captured snapshots: the failed action's
 * placeholder (same call site, no element — capture never probes an action
 * that threw) is filled with the picked element and the confirmed-first
 * alternative list, so the pick rides the normal `piwi-locators` attachment
 * into the dashboard's `locator_snapshots` and healing panel.
 *
 * A failed locator *action* left a placeholder at its call site (same location,
 * no element) — that placeholder is filled in place. An assertion failure left
 * no placeholder (no action ran), so a fresh snapshot is appended under the
 * failing locator's location and signature instead, so the pick still reaches
 * `locator_snapshots`. No-op only when the failing locator has no location.
 * Exported for tests.
 */
export function applyPickToSnapshots(snapshots: LocatorSnapshot[], pick: UserPickResult): boolean {
  // No failing locator (pure inspect pick) or no call site — nothing to key on.
  if (!pick.failing?.location) return false;
  const failing = pick.failing;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = snapshots[i]!;
    if (snap.location !== failing.location || snap.element) continue;
    snapshots[i] = {
      location: snap.location,
      used: snap.used,
      element: pick.element,
      alternatives: pick.alternatives.slice(0, 10),
    };
    return true;
  }
  // No placeholder — an assertion failure. Append a snapshot keyed to the
  // failing locator so the healing lookup finds the pick by location/signature.
  snapshots.push({
    location: failing.location,
    used: {
      method: failing.method,
      args: failing.args,
      raw: `${failing.method}(${JSON.stringify(failing.args)})`,
    },
    element: pick.element,
    alternatives: pick.alternatives.slice(0, 10),
  });
  return true;
}
