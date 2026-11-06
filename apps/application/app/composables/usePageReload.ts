import { onUnmounted } from 'vue';

/** How the mounted pages read their data again, for those that read it their own way. */
const readers = new Set<() => Promise<unknown>>();

/**
 * Registers how the calling page, or a component of it, reads its data again, for as long as it is mounted:
 * `reloadPage` calls `read` in place of refreshing every `useFetch` of the page. A page whose reads keep what it shows
 * when they fail (`refetchKeeping`) registers them here, so a read asked from outside the page (the assistant, once a
 * proposal is applied) keeps it too, and is ordered with the page's own reads. A component registers only on a page
 * that registers its own: once one reader is registered, nothing else of the page is refreshed.
 */
export function usePageReload(read: () => Promise<unknown>): void {
  if (!import.meta.client) return;
  readers.add(read);
  onUnmounted(() => readers.delete(read));
}

/**
 * Reads the shown page's data again: through the readers it registered with `usePageReload`, with the instance's
 * capability states the layout shows, or, for a page that registered none, by refreshing every `useFetch` and
 * `useAsyncData` (`refreshNuxtData()`).
 */
export async function reloadPage(): Promise<void> {
  if (readers.size === 0) {
    await refreshNuxtData();
    return;
  }
  await Promise.all([...[...readers].map((read) => read()), refreshNuxtData('capabilities-instance')]);
}
