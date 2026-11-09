/** The range of a docked panel's width, in rem: the narrowest, where it starts, and the widest. */
export interface DockedPanelRange {
  min: number;
  initial: number;
  max: number;
}

/**
 * The width a panel docked at the page's right edge shows, in rem: the width the person set (`width`), held in
 * `range` and to half the window, which `maxWidth` gives the handle beside it (`DockedPanelHandle`).
 */
export function useDockedPanelWidth(width: Ref<number>, range: DockedPanelRange) {
  const { width: windowWidth } = useWindowSize();
  const rootPx = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const maxWidth = computed(() =>
    import.meta.client ? Math.max(range.min, Math.min(range.max, windowWidth.value / 2 / rootPx())) : range.max,
  );
  const shown = computed(() => Math.round(Math.min(maxWidth.value, Math.max(range.min, width.value)) * 4) / 4);
  return { shown, maxWidth };
}
