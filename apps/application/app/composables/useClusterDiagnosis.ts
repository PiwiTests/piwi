import type { InjectionKey, Ref, ComputedRef } from 'vue';
import type { FailureDiagnosis } from '~~/server/database/schema';
import type { ClusterSuspectLinesAnswer, ContextSection, DiagnosisContextCoverage, ScmChanges } from '~~/types/api';

/**
 * Shared state + actions for the failure-cluster diagnosis page, owned by the
 * page and consumed by `WhatChangedLine`, `ClusterInvestigation` and
 * `DiagnosisPanel` via provide/inject, so the `/context`, `/diagnosis` and
 * `/suspect-lines` endpoints are each fetched once for every panel, and the
 * baseline/selected-commit state stays out of page props/events.
 */

export interface DiagnoseImage {
  name: string;
  mediaType: string;
  data: string;
}

export type { ContextSection };

export interface ClusterDiagnosisStore {
  clusterId: number;

  // Investigation state
  baseCommit: Ref<string>;
  savedBaseCommit: Ref<string>;
  selectedCommitShas: Ref<string[]>;
  autoSelectedCommits: Ref<string[]>;
  baseCommitIsPinned: ComputedRef<boolean>;

  // Shared context (single fetch, used by both panels)
  contextText: Ref<string | null>;
  /** SHA-256 of the current context text — compared with a diagnosis's stored hash for staleness. */
  currentContextSha: Ref<string | null>;
  contextSections: Ref<ContextSection[]>;
  tokenEstimate: Ref<number>;
  imageTokenEstimate: Ref<number>;
  coverage: Ref<DiagnosisContextCoverage | null>;
  scmChanges: Ref<ScmChanges | null>;
  /** The "What changed" card has something to show: a resolved diff or a hand-picked commit range. */
  hasChangesToShow: ComputedRef<boolean>;
  contextLoading: Ref<boolean>;
  /** The first context fetch has answered (it runs once the page is mounted, so never during the server render). */
  contextLoaded: Ref<boolean>;
  refreshContext: () => Promise<void>;

  // Suspect lines (loaded on first use, never in the server render)
  /** The changed lines the failing tests ran; null until loaded, or when the request failed. */
  suspectLines: Ref<ClusterSuspectLinesAnswer | null>;
  /** Fetch the suspect lines; once, unless `force`. */
  loadSuspectLines: (force?: boolean) => Promise<void>;

  // Diagnosis state
  diagnosis: Ref<FailureDiagnosis | null>;
  posting: Ref<boolean>;
  runDiagnosis: (opts?: { force?: boolean; additionalContext?: string; images?: DiagnoseImage[] }) => Promise<void>;
}

const CLUSTER_DIAGNOSIS_KEY: InjectionKey<ClusterDiagnosisStore> = Symbol('cluster-diagnosis');

function createClusterDiagnosisStore(clusterId: number): ClusterDiagnosisStore {
  const toast = useToast();

  const baseCommit = ref('');
  const savedBaseCommit = ref('');
  const selectedCommitShas = ref<string[]>([]);
  const autoSelectedCommits = ref<string[]>([]);
  const baseCommitIsPinned = computed(() => !!savedBaseCommit.value);

  const contextText = ref<string | null>(null);
  const currentContextSha = ref<string | null>(null);
  const contextSections = ref<ContextSection[]>([]);
  const tokenEstimate = ref(0);
  const imageTokenEstimate = ref(0);
  const coverage = ref<DiagnosisContextCoverage | null>(null);
  const scmChanges = ref<ScmChanges | null>(null);
  const contextLoading = ref(false);
  const contextLoaded = ref(false);
  // The "What changed" card — baseline picker, commit browser and diff — opens
  // only with a resolved diff or a hand-picked commit range. With nothing to
  // diff, the situation block's line says why, and the first screen spends
  // nothing on a picker for a diff it does not have.
  const hasChangesToShow = computed(() => Boolean(scmChanges.value) || selectedCommitShas.value.length > 0);

  const suspectLines = ref<ClusterSuspectLinesAnswer | null>(null);
  let suspectLinesRequest: Promise<void> | null = null;
  let suspectLinesAsked = 0;

  const diagnosis = ref<FailureDiagnosis | null>(null);
  const posting = ref(false);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let baseCommitTimer: ReturnType<typeof setTimeout> | null = null;
  let initializing = true;

  function buildContextQuery() {
    const query: Record<string, string | string[]> = {};
    if (baseCommit.value.trim()) query.baseCommit = baseCommit.value.trim();
    if (selectedCommitShas.value.length) query.selectedCommitShas = selectedCommitShas.value;
    return query;
  }

  interface ContextJsonResponse {
    text: string;
    contextSha?: string;
    sections: ContextSection[];
    tokenEstimate: number;
    imageTokenEstimate?: number;
    coverage: DiagnosisContextCoverage;
    scmChanges: ScmChanges | null;
  }

  async function refreshContext() {
    contextLoading.value = true;
    try {
      const res = await $fetch<ContextJsonResponse>(`/api/failure-clusters/${clusterId}/context`, {
        query: { ...buildContextQuery(), format: 'json' },
      });
      contextText.value = res.text;
      currentContextSha.value = res.contextSha ?? null;
      contextSections.value = res.sections;
      tokenEstimate.value = res.tokenEstimate;
      imageTokenEstimate.value = res.imageTokenEstimate ?? 0;
      coverage.value = res.coverage;
      scmChanges.value = res.scmChanges ?? null;
    } catch {
      contextText.value = '(failed to load context)';
      currentContextSha.value = null;
      contextSections.value = [];
      tokenEstimate.value = 0;
      imageTokenEstimate.value = 0;
      coverage.value = null;
      scmChanges.value = null;
    } finally {
      contextLoading.value = false;
      contextLoaded.value = true;
    }
  }

  // The suspect lines read source control and coverage, which can take a while:
  // the first component that shows them asks for them, after the page mounted.
  // Only the latest request's answer is kept, whichever arrives first.
  function loadSuspectLines(force = false): Promise<void> {
    if (suspectLinesRequest && !force) return suspectLinesRequest;
    const asked = ++suspectLinesAsked;
    suspectLinesRequest = $fetch<ClusterSuspectLinesAnswer>(`/api/failure-clusters/${clusterId}/suspect-lines`)
      .then((answer) => {
        if (asked === suspectLinesAsked) suspectLines.value = answer;
      })
      .catch(() => {
        if (asked === suspectLinesAsked) suspectLines.value = null;
      });
    return suspectLinesRequest;
  }

  async function persistBaseCommit(sha: string) {
    try {
      await $fetch(`/api/failure-clusters/${clusterId}/base-commit`, {
        method: 'PATCH',
        body: { commit: sha || null },
      });
      savedBaseCommit.value = sha;
    } catch {
      /* ignore — non-critical */
    }
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPoll() {
    if (pollTimer) return;
    let elapsed = 0;
    pollTimer = setInterval(async () => {
      elapsed += 3000;
      await fetchDiagnosis();
      if (!diagnosis.value || diagnosis.value.status !== 'running' || elapsed >= 120_000) stopPoll();
    }, 3000);
  }

  async function fetchDiagnosis() {
    try {
      const res = await $fetch<{ diagnosis: FailureDiagnosis | null; manualBaseCommit: string | null }>(
        `/api/failure-clusters/${clusterId}/diagnosis`,
      );
      diagnosis.value = res.diagnosis;
    } catch {
      /* ignore */
    }
  }

  async function runDiagnosis(opts: { force?: boolean; additionalContext?: string; images?: DiagnoseImage[] } = {}) {
    posting.value = true;
    try {
      const url = opts.force
        ? `/api/failure-clusters/${clusterId}/diagnose?force=true`
        : `/api/failure-clusters/${clusterId}/diagnose`;
      const body: Record<string, unknown> = {};
      if (opts.additionalContext) body.additionalContext = opts.additionalContext;
      if (baseCommit.value.trim()) body.baseCommit = baseCommit.value.trim();
      if (selectedCommitShas.value.length) body.selectedCommitShas = selectedCommitShas.value;
      if (opts.images?.length) body.images = opts.images;
      diagnosis.value = await $fetch<FailureDiagnosis>(url, {
        method: 'POST',
        body: Object.keys(body).length ? body : undefined,
      });
      if (diagnosis.value?.status === 'running') startPoll();
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 409) startPoll();
      else
        toast.add({ title: 'Diagnosis failed', description: String((err as Error)?.message ?? err), color: 'error' });
    } finally {
      posting.value = false;
    }
  }

  // Re-fetch context when the baseline (debounced) or selected commits change,
  // and persist a changed baseline. Skipped during initial hydration.
  watch(baseCommit, (val) => {
    if (initializing) return;
    if (baseCommitTimer) clearTimeout(baseCommitTimer);
    baseCommitTimer = setTimeout(() => refreshContext(), 900);
    if (val !== savedBaseCommit.value) persistBaseCommit(val);
  });

  watch(
    selectedCommitShas,
    () => {
      if (initializing) return;
      refreshContext();
    },
    { deep: true },
  );

  watch(diagnosis, (val) => {
    if (val?.status === 'running') startPoll();
    else stopPoll();
  });

  // Initial hydration: one /diagnosis call gives both the stored diagnosis and
  // the pinned baseline; then one /context call.
  onMounted(async () => {
    try {
      const res = await $fetch<{ diagnosis: FailureDiagnosis | null; manualBaseCommit: string | null }>(
        `/api/failure-clusters/${clusterId}/diagnosis`,
      );
      diagnosis.value = res.diagnosis;
      if (res.manualBaseCommit) {
        savedBaseCommit.value = res.manualBaseCommit;
        baseCommit.value = res.manualBaseCommit;
      }
      // Pre-fill selected commits and auto-selected commits from stored diagnosis
      const det = res.diagnosis?.details as Record<string, unknown> | null;
      if (det?.selectedCommitShas && Array.isArray(det.selectedCommitShas)) {
        selectedCommitShas.value = det.selectedCommitShas as string[];
      }
      if (det?.autoSelectedCommits && Array.isArray(det.autoSelectedCommits)) {
        autoSelectedCommits.value = det.autoSelectedCommits as string[];
      }
    } catch {
      /* ignore */
    }
    initializing = false;
    refreshContext();
    if (diagnosis.value?.status === 'running') startPoll();
  });

  onScopeDispose(() => {
    stopPoll();
    if (baseCommitTimer) clearTimeout(baseCommitTimer);
  });

  return {
    clusterId,
    baseCommit,
    savedBaseCommit,
    selectedCommitShas,
    autoSelectedCommits,
    baseCommitIsPinned,
    contextText,
    currentContextSha,
    contextSections,
    tokenEstimate,
    imageTokenEstimate,
    coverage,
    scmChanges,
    hasChangesToShow,
    contextLoading,
    contextLoaded,
    refreshContext,
    suspectLines,
    loadSuspectLines,
    diagnosis,
    posting,
    runDiagnosis,
  };
}

/** Create the store and provide it to descendant components. Call once on the page. */
export function provideClusterDiagnosis(clusterId: number): ClusterDiagnosisStore {
  const store = createClusterDiagnosisStore(clusterId);
  provide(CLUSTER_DIAGNOSIS_KEY, store);
  return store;
}

/** Inject the cluster-diagnosis store provided by the page. */
export function useClusterDiagnosis(): ClusterDiagnosisStore {
  const store = inject(CLUSTER_DIAGNOSIS_KEY);
  if (!store) throw new Error('useClusterDiagnosis() must be used under a page that called provideClusterDiagnosis()');
  return store;
}

/**
 * Inject the store if provided by an ancestor (e.g. failure-clusters/[id].vue),
 * otherwise bootstrap a self-contained store using clusterId.
 * Use this in components that may appear both on the cluster page and standalone
 * (cards, modals) where no ancestor calls provideClusterDiagnosis().
 */
export function useOrProvideClusterDiagnosis(clusterId?: number): ClusterDiagnosisStore {
  const store = inject(CLUSTER_DIAGNOSIS_KEY, null);
  if (store) return store;
  if (clusterId == null)
    throw new Error('useOrProvideClusterDiagnosis() requires a clusterId when used outside provideClusterDiagnosis()');
  return provideClusterDiagnosis(clusterId);
}
