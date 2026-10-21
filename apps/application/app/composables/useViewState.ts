import { toValue, type MaybeRefOrGetter, type Ref } from 'vue';

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
  return useState<T>(`view:${route.path}:${key}`, init);
}

/** How long a restore keeps waiting for the page's content to grow tall enough. */
const RESTORE_WINDOW_MS = 3000;

/**
 * How far the element `target` returns is scrolled, kept as view state of the
 * page (see `useViewState`) and scrolled back to when the page is shown again.
 * `key` separates the positions of views sharing one scrolling element, such as
 * the tabs of a page; the position is restored once, when the page mounts.
 *
 * Content can still be arriving then (a list fetched in the browser, a lazy
 * card), so the position is applied again each time the content changes, with
 * the browser's scroll anchoring off, until the user scrolls or clicks or
 * `RESTORE_WINDOW_MS` has passed.
 */
export function useViewScroll(target: () => HTMLElement | null | undefined, key: MaybeRefOrGetter<string> = 'page') {
  const positions = useViewState<Record<string, number>>('scroll', () => ({}));
  if (import.meta.server) return;

  let el: HTMLElement | null = null;
  let restoring = false;
  let stopRestore = () => {};

  function onScroll() {
    if (el && !restoring) positions.value[toValue(key)] = el.scrollTop;
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
    const userEvents = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    stopRestore = () => {
      restoring = false;
      element.style.overflowAnchor = anchoring;
      observer.disconnect();
      clearTimeout(timer);
      for (const type of userEvents) element.removeEventListener(type, stopRestore);
      stopRestore = () => {};
    };
    observer.observe(element, { childList: true, subtree: true, attributes: true });
    for (const type of userEvents) element.addEventListener(type, stopRestore, { passive: true });
    apply();
  }

  onMounted(() => {
    el = target() ?? null;
    if (!el) return;
    el.addEventListener('scroll', onScroll, { passive: true });
    const top = positions.value[toValue(key)] ?? 0;
    if (top > 0) restore(el, top);
  });

  onBeforeUnmount(() => {
    stopRestore();
    el?.removeEventListener('scroll', onScroll);
    el = null;
  });
}

/** The scrolling body of the `UDashboardPanel` whose `id` is `panelId`. */
export function dashboardPanelBody(panelId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#dashboard-panel-${panelId} > [data-slot="body"]`);
}
