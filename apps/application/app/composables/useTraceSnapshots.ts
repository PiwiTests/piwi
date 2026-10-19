import type { MaybeRefOrGetter } from 'vue';
import type { TraceSnapshotsResponse } from '~~/types/api';

/**
 * Fetch the per-action aria / screen snapshots a 1.63 trace recorded for an
 * execution, and build the URLs that serve a single snapshot resource. Shared by
 * the Screen tab, the filmstrip and the in-execution page diff — the `useFetch`
 * key dedupes the one request across all of them.
 */
export function useTraceSnapshots(testRunsCaseId: MaybeRefOrGetter<number>) {
  const config = useRuntimeConfig();

  const { data, pending, error } = useFetch<TraceSnapshotsResponse>(
    () => `/api/test-run-cases/${toValue(testRunsCaseId)}/trace-snapshots`,
    // A reactive key: when the execution changes, its own snapshots load.
    { lazy: true, key: () => `trace-snapshots-${toValue(testRunsCaseId)}` },
  );

  /** URL of one action's aria (JSON) or screen (PNG) snapshot, respecting the app base path. */
  function snapshotUrl(callId: string, kind: 'aria' | 'screen', phase: 'before' | 'after'): string {
    const base = (config.app?.baseURL || '/').replace(/\/$/, '');
    const query = new URLSearchParams({ callId, kind, phase }).toString();
    return `${base}/api/test-run-cases/${toValue(testRunsCaseId)}/trace-snapshot?${query}`;
  }

  const response = computed<TraceSnapshotsResponse | null>(() => data.value ?? null);
  const hasScreen = computed(() => response.value?.status === 'ok' && response.value.hasScreen);
  const hasAria = computed(() => response.value?.status === 'ok' && response.value.hasAria);
  const steps = computed(() => (response.value?.status === 'ok' ? response.value.steps : []));
  const failingStep = computed(() => steps.value.find((s) => s.callId === response.value?.failingCallId) ?? null);
  const failingAriaText = computed(() => response.value?.failingAriaText ?? null);

  return { data: response, pending, error, snapshotUrl, hasScreen, hasAria, steps, failingStep, failingAriaText };
}
