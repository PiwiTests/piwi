import {
  bindToTool,
  endTool,
  installEscapeToCancel,
  isToolActive,
  startTool,
  teardownToolSurfaces,
  toolIsCurrent,
  waitForGlobal,
} from '../shared/tool-session.js';
import {
  installPickerOverlay,
  removePickerOverlay,
  showAnchorPicker,
  generateAnchoredAlternatives,
  mergeCandidates,
  type PickedAnchorInfo,
} from '@piwitests/picker-dom';
import { headingLevel, TAG_TO_ROLE, INPUT_TYPE_TO_ROLE } from '@piwitests/core/locator-generation';
import { initI18n } from '../shared/i18n.js';
import { locatorStability } from '../shared/verdict-words.js';
import { anchorPickerStrings, pickerOverlayStrings } from './picker-strings.js';
import { renderResultsPanel, type ResultsOutcome } from './results-panel.js';
import {
  checkLocators,
  installDescribeHook,
  rankElement,
  ROLE_SOURCES,
  type CheckedLocator,
} from './verified-locators.js';

const PICK_GLOBALS = [
  '__piwiPickState',
  '__piwiPickedElement',
  '__piwiAnchorState',
  '__piwiPickAnchors',
  '__piwiPickChainCount',
] as const;

function clearPickGlobals(): void {
  for (const key of PICK_GLOBALS) delete (globalThis as any)[key];
}

/**
 * Whether a candidate, checked on the page, finds the picked element alone
 * without `.first()` or `.nth()`, and no stability rule calls it brittle.
 */
function findsAlone(checked: readonly CheckedLocator[]): boolean {
  return checked.some(
    (alt) =>
      (alt.verdict === 'unique' || alt.verdict === 'narrowed') && locatorStability(alt.locator).stability !== 'brittle',
  );
}

/**
 * The anchors step for the picked element (`__piwiPickedElement`): the parents
 * the person chose, or none when they skipped it. Undefined once the tool
 * started as `toolEpoch` has ended.
 */
async function askAnchors(
  leaf: { role: string; level: number | null; testId: string | null },
  toolEpoch: number,
): Promise<{ anchors: PickedAnchorInfo[]; chainLeafCount: number | undefined } | undefined> {
  const g = globalThis as any;
  delete g.__piwiAnchorState;
  delete g.__piwiPickAnchors;
  delete g.__piwiPickChainCount;
  showAnchorPicker({
    tagRoles: TAG_TO_ROLE,
    inputRoles: INPUT_TYPE_TO_ROLE,
    roleSources: ROLE_SOURCES,
    leafRole: leaf.role,
    leafLevel: leaf.level,
    leafTestId: leaf.testId,
    strings: anchorPickerStrings(),
  });
  const anchorState = await waitForGlobal<string>('__piwiAnchorState', toolEpoch);
  if (!toolIsCurrent(toolEpoch)) return undefined;
  if (anchorState !== 'done') return { anchors: [], chainLeafCount: undefined };
  return { anchors: g.__piwiPickAnchors ?? [], chainLeafCount: g.__piwiPickChainCount };
}

/**
 * One element: picked on the page, its candidates ranked and checked, then the
 * results. The anchors step opens first only when no candidate finds the
 * element alone; otherwise the results offer it as Scope to a parent, and show
 * again with the scoped candidates checked. Resolves with how the results
 * ended, undefined when they never opened.
 */
async function pickOne(toolEpoch: number): Promise<ResultsOutcome | undefined> {
  const g = globalThis as any;
  clearPickGlobals();
  installPickerOverlay({ transport: 'global', failing: null, strings: pickerOverlayStrings() });
  const state = await waitForGlobal<string>('__piwiPickState', toolEpoch);
  if (state !== 'picked' || !toolIsCurrent(toolEpoch)) return;
  // The element is ours now, so the picking overlay has done its job. Left
  // up it just sits there reading "Analyzing element…" — behind the anchors
  // step, and for the whole life of the results panel.
  removePickerOverlay();

  const el: Element = g.__piwiPickedElement;
  const { attrs, accessibleName, role, ranked: alternatives } = rankElement(el);
  const level = headingLevel({ ...attrs, accessibleName }, role);
  // Checked on the page as it is: verified first, then the others with their real count.
  const check = (anchors: PickedAnchorInfo[], chainLeafCount: number | undefined) =>
    checkLocators(
      el,
      mergeCandidates(alternatives, generateAnchoredAlternatives({ role, level }, anchors, chainLeafCount)),
      { keepAmbiguous: true },
    );

  let checked = check([], undefined);
  let scope = role !== null && !findsAlone(checked);
  for (;;) {
    if (scope && role) {
      const scoped = await askAnchors({ role, level, testId: attrs.attributes['data-testid'] ?? null }, toolEpoch);
      if (!scoped) return;
      if (scoped.anchors.length) checked = check(scoped.anchors, scoped.chainLeafCount);
    }
    if (checked.length === 0) return;
    const outcome = await renderResultsPanel(checked, el, toolEpoch, { canScope: role !== null });
    if (outcome !== 'scope' || !toolIsCurrent(toolEpoch)) return outcome;
    scope = true;
  }
}

/**
 * Runs the full guided pick flow (see {@link pickOne}), once per element the
 * results' Pick another asks for, all in the one tool session. A single
 * injection of this module runs this once. Injected again while a pick runs (a
 * second "Pick element" trigger), it leaves that pick be; any other tool
 * running gives way to it.
 */
async function runPick(): Promise<void> {
  if (isToolActive('pick')) return;
  const toolEpoch = startTool('pick', teardownToolSurfaces);
  installEscapeToCancel();
  const removeDescribeHook = bindToTool(toolEpoch, installDescribeHook());
  try {
    // The overlay, the anchors step and the results speak the language chosen in the settings.
    await initI18n();
    if (!toolIsCurrent(toolEpoch)) return;
    let outcome = await pickOne(toolEpoch);
    while (outcome === 'pick-another' && toolIsCurrent(toolEpoch)) outcome = await pickOne(toolEpoch);
  } catch (err) {
    // A throw anywhere after the pick is logged, and the overlay goes below:
    // left up, it would read "Analyzing element…" for good.
    console.warn('[Piwi Picker] the pick flow failed:', err);
  } finally {
    removeDescribeHook();
    // Belt and braces: covers the early returns above (no locators generated,
    // pick skipped) as well as anything thrown. A pick another tool took over
    // from leaves the overlay and the pick globals to that tool.
    if (toolIsCurrent(toolEpoch)) {
      removePickerOverlay();
      clearPickGlobals();
    }
    endTool(toolEpoch);
  }
}

void runPick();
