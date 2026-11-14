/**
 * The single recommended fix among ranked alternative locators: the one that
 * keeps the original locator's style when that style is stable enough, else the
 * most stable one. The style is read from the failing locator alone (the method
 * of its last call), never from the suite's other locators. Shared by locator
 * healing (server, dashboard), the editor service and the browser extension's
 * replacements for brittle locators, so all pick a fix the same way.
 */
import type { LocatorFixRecommendation, RankedLocator } from './locator-healing-types';

/**
 * Method family for each locator method. The single recommended fix prefers an
 * alternative from the same family as the failing locator, so the edit stays
 * idiomatic to the developer's original style:
 *  - `semantic`: role + accessible name (and the equivalent aria-label form)
 *  - `text`:     visible text (`getByText`/`getByAltText`/`getByTitle`)
 *  - `label`:    form-field label (`getByLabel`/`getByPlaceholder`)
 *  - `testid`:   purpose-built test id (the usual escalation target)
 *  - `css`:      raw CSS/selector (`locator`)
 */
export const LOCATOR_FAMILY: Record<string, string> = {
  getByTestId: 'testid',
  getByRole: 'semantic',
  getByLabel: 'label',
  getByPlaceholder: 'label',
  getByText: 'text',
  getByAltText: 'text',
  getByTitle: 'text',
  locator: 'css',
  'page.locator': 'css',
};

/**
 * Stability floor a same-family pick must clear to be recommended. Below this
 * the original style is too fragile to keep (e.g. a raw `locator('.btn-abc123')`),
 * so the recommendation escalates to the most stable alternative instead.
 */
export const CONVENTION_STABILITY_FLOOR = 50;

/**
 * Choose the single recommended fix from a stability-ranked alternative list,
 * keeping the developer's original locator style where it is stable enough.
 *
 * The full menu (`alternatives`) is still ranked by raw stability; this only
 * decides which one to surface as the "Top recommendation" / the AI's
 * `suggestedFix.code`. Ladder:
 *   1. same method, then same family — the most stable such pick that clears the floor;
 *   2. otherwise the most stable alternative overall (usually `getByTestId`);
 *   3. when even that is below the floor, flag that a `data-testid` should be added.
 *
 * `alternatives` MUST be sorted descending by score (as stored). Pure — runs at
 * read time, no capture change.
 */
export function recommendLocatorFix(
  failingMethod: string | null | undefined,
  alternatives: RankedLocator[],
  floor: number = CONVENTION_STABILITY_FLOOR,
): LocatorFixRecommendation {
  const durable = alternatives[0] ?? null;

  if (!durable) {
    return {
      recommended: null,
      durable: null,
      preservesConvention: false,
      hasDurableAlternative: false,
      suggestAddTestId: false,
    };
  }

  // Same method first, then same family — take the most stable pick (the list is
  // pre-sorted, so the first match is the strongest) that clears the floor.
  const family = failingMethod ? LOCATOR_FAMILY[failingMethod] : undefined;
  const conventionPick =
    (failingMethod ? alternatives.find((a) => a.method === failingMethod && a.score >= floor) : undefined) ??
    (family ? alternatives.find((a) => LOCATOR_FAMILY[a.method] === family && a.score >= floor) : undefined);

  // A human-confirmed pick (the reporter's failure-time locator picker)
  // outranks the convention ladder — it is the one alternative a person
  // verified against the intended element on the failing page.
  const userPick = alternatives.find((a) => a.pickedByUser);

  // Escalate to the most stable alternative when nothing in the original family
  // is stable enough to keep.
  const recommended = userPick ?? conventionPick ?? durable;

  return {
    recommended,
    durable,
    preservesConvention: !!conventionPick && recommended === conventionPick,
    hasDurableAlternative: recommended.locator !== durable.locator,
    // Even the most stable alternative is fragile — recommend adding a test id.
    suggestAddTestId: durable.score < floor,
  };
}
