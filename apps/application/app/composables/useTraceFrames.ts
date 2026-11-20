import type { MaybeRefOrGetter } from 'vue';
import type { TraceFramesResponse } from '~~/types/api';

/**
 * The screencast frames of an execution's trace, for the failure timeline's
 * Screen lane, and the URL that serves one frame. Loaded in the browser once
 * `load` holds, after the axis: the lane is below the first screen.
 */
export function useTraceFrames(id: MaybeRefOrGetter<number>, load: MaybeRefOrGetter<boolean>) {
  const config = useRuntimeConfig();
  // The execution the loaded list belongs to: while another one's list loads, none is shown.
  const loadedFor = ref<number | null>(null);
  const frames = useFetch<TraceFramesResponse>(() => `/api/test-run-cases/${toValue(id)}/trace-frames`, {
    key: () => `trace-frames-${toValue(id)}`,
    server: false,
    lazy: true,
    immediate: toValue(load),
    watch: false,
    onResponse: ({ request }) => {
      const match = /\/test-run-cases\/(\d+)\/trace-frames/.exec(String(request));
      loadedFor.value = match ? Number(match[1]) : null;
    },
  });
  const data = computed(() => (loadedFor.value === toValue(id) ? frames.data.value : null));
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

  return { data, frameUrl };
}
