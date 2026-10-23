export { revealQuery, routeOnPage, stopRoute } from '#shared/guide-stops';

/** The selector of the element a guide anchor names. */
export function anchorSelector(id: string): string {
  return `[data-tour="${id}"]`;
}
