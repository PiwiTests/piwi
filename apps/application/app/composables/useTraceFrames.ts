import type { MaybeRefOrGetter } from 'vue';
import type { TraceFramesResponse } from '~~/types/api';

/**
 * The screencast frames of an execution's trace, for the failure timeline's
 * Screen lane, and the URL that serves one frame. Loaded in the browser once
 * `load` holds, after the axis: the lane is below the first screen.
 */
export function useTraceFrames(id: MaybeRefOrGetter<number>, load: MaybeRefOrGetter<boolean>) {
  const config = useRuntimeConfig();
  const frames = useFetch<TraceFramesResponse>(() => `/api/test-run-cases/${toValue(id)}/trace-frames`, {
    key: () => `trace-frames-${toValue(id)}`,
    server: false,
    lazy: true,
    immediate: toValue(load),
    watch: false,
  });
  watch(
    () => [toValue(id), toValue(load)] as const,
    ([, needed]) => {
      if (needed && frames.status.value !== 'success') void frames.execute();
    },
  );

  /** URL of one frame, respecting the app base path. */
  function frameUrl(name: string): string {
    const base = (config.app?.baseURL || '/').replace(/\/$/, '');
    return `${base}/api/test-run-cases/${toValue(id)}/trace-frame?name=${encodeURIComponent(name)}`;
  }

  return { data: frames.data, frameUrl };
}
