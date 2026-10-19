/**
 * Whether a click on a link is the browser's to handle: one with a modifier key
 * (a new tab or window, a download) or with another button than the main one.
 * A link that routes in the app on a plain click leaves these alone.
 */
export function isModifiedClick(event: MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}
