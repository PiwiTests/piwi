/**
 * When the server rendered the page, by the server's clock, kept in the page's payload so the browser reads the
 * server's value: the time the page's data was read. A page rendered in the browser alone (the demo) gets the
 * browser's time. Set by `plugins/rendered-at.ts` for every page.
 */
export function useRenderedAt() {
  return useState<number>('piwi-rendered-at', () => Date.now());
}
