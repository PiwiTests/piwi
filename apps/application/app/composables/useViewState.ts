import { toValue, type MaybeRefOrGetter, type Ref } from 'vue';

/** How many pages keep their view state; the page shown least recently beyond them starts afresh. */
const KEPT_PAGES = 50;

/**
 * View state of a page — a search, the filters, a sort, the open groups of a
 * list — kept for the browser tab's session under the page's path, so leaving
 * the page and coming back (Back, a breadcrumb, a link) shows the page as the
 * user left it. `key` names the state within the page; two lists on one page
 * take two keys.
 *
 * The state lives in `useState`, so a reload starts again from `init`, on the
 * server and in the browser alike, and the first render never mismatches.
 * Store plain values (strings, numbers, arrays, objects): a `Set` or `Map` is
 * an array here and a computed around it.
 */
export function useViewState<T>(key: string, init: () => T): Ref<T> {
  const route = useRoute();
  keepPage(route.path);
  return useState<T>(`view:${route.path}:${key}`, init);
}

/** Marks `path` as the page shown last, and clears the view state of the pages past `KEPT_PAGES`. */
function keepPage(path: string) {
  const pages = useState<string[]>('view-pages', () => []);
  if (pages.value.at(-1) === path) return;
  const next = [...pages.value.filter((page) => page !== path), path];
  const dropped = next.splice(0, Math.max(0, next.length - KEPT_PAGES));
  pages.value = next;
  if (dropped.length > 0)
    clearNuxtState((stateKey) => dropped.some((page) => stateKey.startsWith(`view:${page}:`)), { reset: false });
}

/** How long a restore keeps the position while the page's content arrives. */
const RESTORE_WINDOW_MS = 3000;
/** Input that hands the scroll back to the user during a restore. */
const USER_INPUT_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/**
 * How far the element `target` returns is scrolled, kept as view state of the
 * page (see `useViewState`) and scrolled back to when the page is shown again.
 * `key` separates the positions of views sharing one scrolling element, such as
 * the tabs of a page: a tab switch records the position of the tab it leaves,
 * and the position of the active tab is restored when the page mounts.
 *
 * Content can still be arriving then (a list fetched in the browser, a lazy
 * card), so the position is applied again each time the content changes, with
 * the browser's scroll anchoring off, until the user scrolls, clicks or types,
 * or `RESTORE_WINDOW_MS` has passed.
 */
export function useViewScroll(target: () => HTMLElement | null | undefined, key: MaybeRefOrGetter<string> = 'page') {
  const positions = useViewState<Record<string, number>>('scroll', () => ({}));
  if (import.meta.server) return;

  let el: HTMLElement | null = null;
  let restoring = false;
  let stopRestore = () => {};

  function record(viewKey: string) {
    if (el && !restoring) positions.value[viewKey] = el.scrollTop;
  }

  function restore(element: HTMLElement, top: number) {
    restoring = true;
    const anchoring = element.style.overflowAnchor;
    element.style.overflowAnchor = 'none';
    const apply = () => {
      if (restoring) element.scrollTop = top;
    };
    const observer = new MutationObserver(() => requestAnimationFrame(apply));
    const timer = setTimeout(() => stopRestore(), RESTORE_WINDOW_MS);
    stopRestore = () => {
      restoring = false;
      element.style.overflowAnchor = anchoring;
      observer.disconnect();
      clearTimeout(timer);
      for (const type of USER_INPUT_EVENTS) window.removeEventListener(type, stopRestore, { capture: true });
      stopRestore = () => {};
    };
    observer.observe(element, { childList: true, subtree: true, attributes: true });
    for (const type of USER_INPUT_EVENTS) window.addEventListener(type, stopRestore, { capture: true, passive: true });
    apply();
  }

  // Runs before the new view renders, while the element still shows the one being left.
  watch(
    () => toValue(key),
    (_, previous) => {
      stopRestore();
      record(previous);
    },
    { flush: 'pre' },
  );

  onMounted(() => {
    el = target() ?? null;
    if (!el) return;
    const top = positions.value[toValue(key)] ?? 0;
    if (top > 0) restore(el, top);
  });

  onBeforeUnmount(() => {
    record(toValue(key));
    stopRestore();
    el = null;
  });
}

/** The scrolling body of the `UDashboardPanel` whose `id` is `panelId`. */
export function dashboardPanelBody(panelId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#dashboard-panel-${panelId} > [data-slot="body"]`);
}
