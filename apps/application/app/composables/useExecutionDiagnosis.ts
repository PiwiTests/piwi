import type { FailureDiagnosis } from '~~/server/database/schema';
import type { ContextSection, DiagnosisContextCoverage } from '~~/types/api';
import { errorMessage } from '~/utils';

/** How often a diagnosis running elsewhere (another tab, a policy) is read again. */
const RUNNING_POLL_MS = 4_000;
/** A diagnosis still running after this long is stuck: the panel offers to restart it, and it is no longer polled. */
const RUNNING_STALE_MS = 5 * 60 * 1000;

/**
 * Execution-scoped diagnosis state, shaped like the cluster-diagnosis store so
 * `DiagnosisPanel` can drive either scope through one interface. Execution scope
 * has no SCM baseline, no streaming and no version history server-side, so those
 * fields are inert stubs the panel simply does not render for this scope.
 */
export function useExecutionDiagnosis(executionId: number) {
  const toast = useToast();

  const diagnosis = ref<FailureDiagnosis | null>(null);
  const posting = ref(false);

  const contextSections = ref<ContextSection[]>([]);
  const tokenEstimate = ref(0);
  const imageTokenEstimate = ref(0);
  const coverage = ref<DiagnosisContextCoverage | null>(null);
  const contextLoading = ref(false);

  interface ContextJsonResponse {
    text: string;
    sections: ContextSection[];
    tokenEstimate: number;
    imageTokenEstimate?: number;
    coverage: DiagnosisContextCoverage;
  }

  async function refreshContext() {
    contextLoading.value = true;
    try {
      const res = await $fetch<ContextJsonResponse>(`/api/test-run-cases/${executionId}/diagnosis-context`, {
        query: { format: 'json' },
      });
      contextSections.value = res.sections;
      tokenEstimate.value = res.tokenEstimate;
      imageTokenEstimate.value = res.imageTokenEstimate ?? 0;
      coverage.value = res.coverage;
    } catch {
      contextSections.value = [];
      tokenEstimate.value = 0;
      imageTokenEstimate.value = 0;
      coverage.value = null;
    } finally {
      contextLoading.value = false;
    }
  }

  async function fetchDiagnosis() {
    try {
      const res = await $fetch<{ diagnosis: FailureDiagnosis | null }>(`/api/test-run-cases/${executionId}/diagnosis`);
      diagnosis.value = res.diagnosis;
    } catch {
      /* ignore — nothing stored */
    }
  }

  // While a diagnosis this page did not start is running, read it again until it lands.
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }
  function schedulePoll() {
    stopPolling();
    const d = diagnosis.value;
    if (posting.value || d?.status !== 'running') return;
    if (Date.now() - new Date(d.updatedAt).getTime() > RUNNING_STALE_MS) return;
    pollTimer = setTimeout(async () => {
      await fetchDiagnosis();
      schedulePoll();
    }, RUNNING_POLL_MS);
  }
  watch([() => diagnosis.value?.status, posting], schedulePoll);
  onBeforeUnmount(stopPolling);

  async function runDiagnosis(opts: { force?: boolean; additionalContext?: string } = {}) {
    posting.value = true;
    try {
      const url = opts.force
        ? `/api/test-run-cases/${executionId}/diagnose?force=true`
        : `/api/test-run-cases/${executionId}/diagnose`;
      const body = opts.additionalContext ? { additionalContext: opts.additionalContext } : undefined;
      diagnosis.value = await $fetch<FailureDiagnosis>(url, { method: 'POST', body });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 409) {
        toast.add({ title: 'Diagnosis already running', color: 'warning' });
        fetchDiagnosis();
      } else if (status === 503) {
        toast.add({ title: 'AI diagnosis is not configured', color: 'warning' });
      } else {
        toast.add({ title: 'Diagnosis failed', description: errorMessage(err), color: 'error' });
      }
    } finally {
      posting.value = false;
    }
  }

  onMounted(() => {
    fetchDiagnosis();
    refreshContext();
  });

  return {
    diagnosis,
    posting,
    contextSections,
    tokenEstimate,
    imageTokenEstimate,
    coverage,
    contextLoading,
    refreshContext,
    fetchDiagnosis,
    runDiagnosis,
  };
}
