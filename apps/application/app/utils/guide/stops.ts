import type { GuideAnchor } from '#shared/guide-anchors/index.mjs';

export { revealQuery, routeOnPage, stopRoute } from '#shared/guide-stops';

/** The selector of the element a guide anchor names. */
export function anchorSelector(id: string): string {
  return `[data-tour="${id}"]`;
}

/**
 * Whether an anchor sits in a layer its reveal opens: a popover, a menu, a
 * drawer or a modal, whose opener an `open` step clicks.
 */
export function opensLayer(anchor: GuideAnchor | undefined): boolean {
  return anchor?.reveal?.some((step) => 'open' in step) ?? false;
}
