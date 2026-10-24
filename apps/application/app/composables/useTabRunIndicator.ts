import type { ComputedRef } from 'vue';
import logoSvg from '~~/public/logo.svg?raw';
import {
  finishedRunTabIndicator,
  liveRunTabIndicator,
  runFaviconSvg,
  svgDataUrl,
  type TabRunCounts,
  type TabRunIndicator,
} from '~/utils/tab-run-indicator';

/** The watched run as the page knows it: whether it is in flight, its status and its counts so far. */
export interface TabRunState extends TabRunCounts {
  live: boolean;
  status: string;
}

/**
 * Show the progress of the run a page is watching on its browser tab: a badge
 * over the favicon and the progress returned for the page to put ahead of its
 * title (`tabRunTitle`). When the run ends while the page is open, its outcome
 * stays on the tab for a moment, and for as long as the tab is in the
 * background, so it is still there to see on coming back. The favicon is
 * restored when the page unmounts.
 *
 * The desktop shell shows runs on its own window title and tray, and has no
 * tab, so inside it this does nothing.
 */
export function useTabRunIndicator(run: () => TabRunState | null): ComputedRef<TabRunIndicator | null> {
  if (useIsDesktop()) return computed(() => null);

  const finished = ref<TabRunIndicator | null>(null);
  let finishedFor = 0;
  const visibility = useDocumentVisibility();

  const indicator = computed(() => {
    const state = run();
    if (state?.live) return liveRunTabIndicator(state);
    return finished.value;
  });

  watch(
    () => {
      const state = run();
      return state ? { live: state.live, status: state.status } : null;
    },
    (now, before) => {
      if (now?.live) {
        finished.value = null;
      } else if (before?.live && now) {
        const flash = finishedRunTabIndicator(now.status);
        finished.value = flash?.indicator ?? null;
        finishedFor = flash?.durationMs ?? 0;
      }
    },
  );

  // The outcome clears once the tab has been in view for its flash duration.
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  watch([finished, visibility], ([shown, visible]) => {
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = null;
    if (shown && visible === 'visible') {
      clearTimer = setTimeout(() => {
        finished.value = null;
      }, finishedFor);
    }
  });
  onScopeDispose(() => {
    if (clearTimer) clearTimeout(clearTimer);
  });

  // The `favicon` key replaces the app's icon link (app.vue) while a badge shows.
  const favicon = computed(() => {
    const shown = indicator.value;
    if (!shown || !import.meta.client) return null;
    // An image cannot read the page's variables, so the status token is resolved here.
    const color =
      getComputedStyle(document.documentElement).getPropertyValue(`--color-status-${shown.status}`).trim() ||
      'currentColor';
    return svgDataUrl(runFaviconSvg(logoSvg, shown, color));
  });
  useHead({
    link: computed(() =>
      favicon.value ? [{ key: 'favicon', rel: 'icon', type: 'image/svg+xml', href: favicon.value }] : [],
    ),
  });

  return indicator;
}
