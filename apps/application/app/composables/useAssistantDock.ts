import { createSharedComposable } from '@vueuse/core';

/** From this width up the assistant's panel docks beside the page, unless the user floats it. */
const DOCK_QUERY = '(min-width: 1280px)';

/** The docked panel's width, in rem: what it starts at and the range a drag keeps it in. */
export const ASSISTANT_DOCK_WIDTH = { min: 22, initial: 28, max: 48 } as const;

/**
 * Where the assistant's panel sits: docked beside the page from 1280 px up,
 * the page narrowing to make room, unless the user floats it over the page;
 * below that, over the page (full screen on a phone). The choice and the
 * docked panel's width are this browser's, kept in `localStorage`.
 */
function _useAssistantDock() {
  const wide = useMediaQuery(DOCK_QUERY);
  const floating = useLocalStorage('piwi-assistant-floating', false, { initOnMounted: true });
  const width = useLocalStorage<number>('piwi-assistant-width', ASSISTANT_DOCK_WIDTH.initial, { initOnMounted: true });

  /** Whether the panel docks beside the page. */
  const docked = computed(() => wide.value && !floating.value);

  return { wide, floating, docked, width };
}

export const useAssistantDock = createSharedComposable(_useAssistantDock);
