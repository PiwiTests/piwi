import type { InjectionKey } from 'vue';
import type { MarkerInfo } from '~~/types/api';

/** The hovered marker of a chart, with the tooltip position and whether a click opens it. */
type MarkerTooltipState = ReturnType<typeof useChartTooltip<MarkerInfo>> & { clickable: Ref<boolean> };

const MARKER_TOOLTIP_KEY: InjectionKey<MarkerTooltipState> = Symbol('chart-marker-tooltip');

/**
 * Marker tooltip state shared by a `ChartFrame` and the `ChartMarkerLines` in
 * its slot. The frame owns it and renders the tooltip next to its `<svg>`: a
 * tooltip rendered from inside the SVG, even through `Teleport`, is created in
 * the SVG namespace, where an HTML `div` never displays.
 */
export function provideChartMarkerTooltip(): MarkerTooltipState {
  const state = { ...useChartTooltip<MarkerInfo>(280), clickable: ref(false) };
  provide(MARKER_TOOLTIP_KEY, state);
  return state;
}

export function useChartMarkerTooltip(): MarkerTooltipState {
  const state = inject(MARKER_TOOLTIP_KEY, null);
  if (!state) throw new Error('ChartMarkerLines must be rendered inside a ChartFrame');
  return state;
}
