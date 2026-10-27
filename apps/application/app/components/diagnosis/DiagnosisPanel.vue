<script setup lang="ts">
/**
 * AI diagnosis for a failure cluster or a single execution — one component, one
 * `scope`. The stored result renders whether or not a provider is configured, so
 * a diagnosis never disappears when the key is removed; the interactive controls
 * (diagnose, additional context, screenshots) show only when a provider is set,
 * and running a diagnosis to the holders of `ai:run` on the project.
 *
 * Cluster scope uses the shared cluster-diagnosis store (SCM baseline, streaming,
 * version history). Execution scope has none of those server-side, so it runs the
 * plain diagnose endpoint and hides the baseline, streaming and history UI.
 */
import type { FailureDiagnosis } from '~~/server/database/schema';
import { extractCitedSectionIds } from '#shared/diagnosis-sections';
import { isDiagnosisStale, stalenessReason } from '#shared/diagnosis-staleness';
import { isAgentDiagnosis } from '#shared/agent-diagnosis';
import type { DiagnoseImage } from '~/composables/useClusterDiagnosis';
import { formatRelativeTime } from '~/utils';

const props = withDefaults(
  defineProps<{
    scope: 'cluster' | 'execution';
    clusterId?: number;
    executionId?: number;
    /** The project the cluster or execution belongs to; `ai:run` there gates running a diagnosis. */
    projectId?: number | null;
    /**
     * Keep *Show context* and *Copy prompt* out of the panel; the page renders
     * them in its own More menu, opening the context through the exposed method
     * and copying the prompt from the same context endpoint.
     */
    contextInMenu?: boolean;
    // ── Cluster scope only ──
    lastSeenRunId?: number;
    clusterStatus?: string;
    fixVerification?: string | null;
    lastSeenAt?: string | Date | null;
    affectedTestCases?: Array<{
      testCaseId: number;
      title: string;
      filePath: string;
      runCount: number;
      recentTestRunsCaseId: number;
    }>;
  }>(),
  { contextInMenu: false },
);

const isCluster = props.scope === 'cluster';

// The prompt/context endpoint — scope-agnostic downstream (CopyAiPromptButton).
const contextEndpoint = computed(() =>
  isCluster
    ? `/api/failure-clusters/${props.clusterId}/context`
    : `/api/test-run-cases/${props.executionId}/diagnosis-context`,
);

// One store, two shapes. `scope` never changes for a mounted panel, so picking
// the store once at setup is safe.
const clusterStore = isCluster ? useOrProvideClusterDiagnosis(props.clusterId) : null;
const execStore = !isCluster ? useExecutionDiagnosis(props.executionId!) : null;

const diagnosis = clusterStore?.diagnosis ?? execStore!.diagnosis;
const posting = clusterStore?.posting ?? execStore!.posting;
const contextSections = clusterStore?.contextSections ?? execStore!.contextSections;
const tokenEstimate = clusterStore?.tokenEstimate ?? execStore!.tokenEstimate;
const imageTokenEstimate = clusterStore?.imageTokenEstimate ?? execStore!.imageTokenEstimate;
const coverage = clusterStore?.coverage ?? execStore!.coverage;
const contextLoading = clusterStore?.contextLoading ?? execStore!.contextLoading;
const refreshContext = clusterStore?.refreshContext ?? execStore!.refreshContext;
const currentContextSha = clusterStore?.currentContextSha ?? ref<string | null>(null);

const { aiStatus } = useAiStatus();
const { can } = useAuth();
const canRun = computed(() => can('ai:run', props.projectId));

// Streaming lives on cluster scope only; execution falls back to plain POST.
const streaming = isCluster ? useStreamingDiagnosis(computed(() => props.clusterId ?? 0)) : null;
const streamThinkingText = streaming?.thinkingText ?? ref('');
const streamStage = streaming?.stage ?? ref<string | null>(null);
const streamStatus = streaming?.status ?? ref('idle');
const streamResult = streaming?.result ?? ref<FailureDiagnosis | null>(null);
const streamError = streaming?.error ?? ref<string | null>(null);

const attachments = useAttachments();
const {
  files: attachedFiles,
  images: attachedImages,
  dragOver,
  processFiles,
  onDragOver,
  onDragLeave,
  onDrop,
  removeFile,
  removeImage,
} = attachments;

const additionalContext = ref('');
const fileInputRef = ref<HTMLInputElement | null>(null);
const testCaseImages = ref<DiagnoseImage[]>([]);

const allImages = computed<DiagnoseImage[]>(() => [
  ...testCaseImages.value,
  ...(attachedImages.value.length ? attachments.imagesPayload() : []),
]);

const showAiContext = ref(false);
const showAdditionalContext = ref(false);
const focusSection = ref<string | null>(null);

const thinkingContainer = ref<HTMLElement | null>(null);

/** Open the AI context modal focused on a section (from an evidence citation). */
function onViewSection(sectionId: string) {
  focusSection.value = sectionId;
  showAiContext.value = true;
}

/** Section ids the diagnosis actually cited — highlighted in the context modal. */
const citedSections = computed<string[]>(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const det = diagnosis.value?.details as any;
  if (!det) return [];
  const texts: string[] = [];
  if (Array.isArray(det.evidence)) texts.push(...det.evidence);
  if (Array.isArray(det.hypotheses)) {
    for (const h of det.hypotheses) if (Array.isArray(h?.evidence)) texts.push(...h.evidence);
  }
  return extractCitedSectionIds(texts);
});

/** Auto-scroll the thinking container as new tokens arrive. */
watch(streamThinkingText, () => {
  nextTick(() => {
    if (thinkingContainer.value) {
      thinkingContainer.value.scrollTop = thinkingContainer.value.scrollHeight;
    }
  });
});

/** When streaming completes with a result, update the shared diagnosis store. */
watch(streamResult, (val) => {
  if (val) diagnosis.value = val;
});

/** Pre-fill additional context from a stored diagnosis. */
watch(
  () => diagnosis.value?.details,
  (det) => {
    if (!det) return;
    const d = det as Record<string, unknown>;
    if (typeof d.additionalContext === 'string' && d.additionalContext.trim() && !additionalContext.value) {
      additionalContext.value = d.additionalContext;
    }
  },
  { immediate: true },
);

/** Assisted iteration: pre-fill the additional-context box and open it. */
function onPrefillContext(text: string) {
  additionalContext.value = additionalContext.value ? `${additionalContext.value}\n\n${text}` : text;
  showAdditionalContext.value = true;
}

function buildPromptContext() {
  const parts: string[] = [];
  if (additionalContext.value.trim()) parts.push(additionalContext.value.trim());
  const filesMd = attachments.filesMarkdown();
  if (filesMd) parts.push(filesMd);
  return parts.join('\n\n');
}

async function diagnose(force = false) {
  if (streaming && clusterStore) {
    await streaming.startStream({
      force,
      additionalContext: buildPromptContext() || undefined,
      baseCommit: clusterStore.baseCommit.value.trim() || undefined,
      selectedCommitShas: clusterStore.selectedCommitShas.value.length
        ? [...clusterStore.selectedCommitShas.value]
        : undefined,
      images: allImages.value.length ? allImages.value : undefined,
    });
  } else {
    await diagnoseFallback(force);
  }
}

async function diagnoseFallback(force = false) {
  if (clusterStore) {
    await clusterStore.runDiagnosis({
      force,
      additionalContext: buildPromptContext() || undefined,
      images: allImages.value.length ? allImages.value : undefined,
    });
  } else {
    await execStore!.runDiagnosis({ force, additionalContext: buildPromptContext() || undefined });
  }
}

function markDiagnosisFailed() {
  diagnosis.value = null;
}

function isStale(d: FailureDiagnosis) {
  return d.status === 'running' && Date.now() - new Date(d.updatedAt).getTime() > 5 * 60 * 1000;
}

function isStreaming() {
  return streamStatus.value === 'streaming';
}

function showDiagnoseButton() {
  return (
    canRun.value &&
    !isStreaming() &&
    (!diagnosis.value || diagnosis.value.status === 'failed' || isStale(diagnosis.value))
  );
}

function showResult() {
  return (
    !isStreaming() && diagnosis.value && (diagnosis.value.status === 'completed' || diagnosis.value.status === 'failed')
  );
}

/** Read an execution's in-flight diagnosis again (it is also polled while it runs). */
const refreshingDiagnosis = ref(false);
async function refreshRunningDiagnosis() {
  refreshingDiagnosis.value = true;
  try {
    await execStore?.fetchDiagnosis();
  } finally {
    refreshingDiagnosis.value = false;
  }
}

/** A fresh 'running' row (execution scope, no live stream): a diagnosis is in flight. */
const showRunning = computed(
  () => !isCluster && diagnosis.value?.status === 'running' && !isStale(diagnosis.value) && !posting.value,
);

// ── Staleness (cluster scope) ───────────────────────────────────────────────
const stalenessInput = computed(() => ({
  storedContextSha: diagnosis.value?.contextSha,
  currentContextSha: currentContextSha.value,
  fixVerification: props.fixVerification,
  status: props.clusterStatus,
}));

const diagnosisStale = computed(
  () => isCluster && diagnosis.value?.status === 'completed' && isDiagnosisStale(stalenessInput.value),
);

const staleReason = computed<'occurrences' | 'evidence' | null>(() =>
  isCluster
    ? stalenessReason({
        ...stalenessInput.value,
        diagnosedAt: diagnosis.value?.updatedAt ? new Date(diagnosis.value.updatedAt).getTime() : null,
        lastSeenAt: props.lastSeenAt ? new Date(props.lastSeenAt).getTime() : null,
      })
    : null,
);

// ── History (cluster scope only — no execution versions endpoint) ───────────
const showHistory = ref(false);
const versionCount = ref(0);

async function fetchVersionCount() {
  if (!isCluster || !props.clusterId) return;
  try {
    const res = await $fetch<{ items: unknown[] }>(`/api/failure-clusters/${props.clusterId}/diagnoses`);
    versionCount.value = res.items.length;
  } catch {
    versionCount.value = 0;
  }
}

onMounted(fetchVersionCount);
// A completed re-diagnose snapshots the prior version — refresh the count.
watch(
  () => diagnosis.value?.updatedAt,
  () => fetchVersionCount(),
);

// ── Re-diagnose (exposed for the page's next step) ───────────────────────────
const canReDiagnose = computed(() =>
  Boolean(canRun.value && aiStatus.value?.configured && diagnosis.value?.status === 'completed'),
);

defineExpose({
  openContext: () => (showAiContext.value = true),
  openHistory: () => (showHistory.value = true),
  reDiagnose: () => diagnose(true),
  canReDiagnose,
  versionCount,
  posting,
});
</script>

<template>
  <div class="space-y-4">
    <!-- Action row: the panel's own header (FixCard supplies the "Diagnosis" label). -->
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs text-gray-400 inline-flex items-center gap-1">
        <UIcon name="i-lucide-triangle-alert" class="size-3 shrink-0" />
        {{ isAgentDiagnosis(diagnosis?.provider) ? 'Written by an agent' : 'AI-generated' }}, verify before applying
      </span>
      <div class="flex items-center gap-1.5">
        <UButton
          v-if="isCluster && versionCount > 0"
          icon="i-lucide-history"
          size="xs"
          color="neutral"
          variant="outline"
          title="View previous diagnosis versions"
          @click="showHistory = true"
        >
          History ({{ versionCount }})
        </UButton>
        <!-- A stored result under no provider: configuring AI is the way to redo it. -->
        <UButton
          v-if="showResult() && !aiStatus?.configured"
          to="/settings/ai"
          icon="i-lucide-sparkles"
          size="xs"
          color="neutral"
          variant="outline"
        >
          Re-diagnose (configure AI)
        </UButton>
        <template v-if="!contextInMenu && aiStatus?.configured">
          <CopyAiPromptButton :context-endpoint="contextEndpoint" />
          <UButton
            :icon="showAiContext ? 'i-lucide-eye-off' : 'i-lucide-eye'"
            size="xs"
            color="neutral"
            variant="outline"
            :loading="contextLoading"
            @click="showAiContext = !showAiContext"
          >
            {{ showAiContext ? 'Hide context' : 'Show context' }}
          </UButton>
        </template>
        <UButton
          v-if="canReDiagnose"
          icon="i-lucide-refresh-cw"
          size="xs"
          color="primary"
          variant="soft"
          :loading="posting"
          @click="diagnose(true)"
        >
          Re-diagnose
        </UButton>
      </div>
    </div>

    <!-- Context coverage preview: what evidence will be sent, without opening the modal -->
    <DiagnosisCoverageStrip
      v-if="aiStatus?.configured"
      :sections="contextSections"
      :token-estimate="tokenEstimate"
      :loading="contextLoading"
      @view-section="onViewSection"
      @open="showAiContext = true"
    />

    <!-- Context modal -->
    <DiagnosisContextModal
      :open="showAiContext"
      :sections="contextSections"
      :token-estimate="tokenEstimate"
      :image-token-estimate="imageTokenEstimate"
      :loading="contextLoading"
      :focus-section="focusSection"
      :cited-sections="citedSections"
      :not-applicable-sections="coverage?.notApplicable"
      @update:open="
        showAiContext = $event;
        if (!$event) focusSection = null;
      "
      @refresh="refreshContext"
    />

    <!-- AI configured: interactive controls -->
    <template v-if="aiStatus?.configured">
      <!-- Additional context (collapsible, collapsed by default) -->
      <div data-tour="diagnosis-additional-context">
        <div class="flex items-center gap-1 mb-1">
          <button
            class="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-left"
            @click="showAdditionalContext = !showAdditionalContext"
          >
            <UIcon
              :name="showAdditionalContext ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              class="size-3.5"
            />
            Additional context
            <span v-if="attachedFiles.length || attachedImages.length || additionalContext.trim()" class="text-primary">
              ({{ attachedFiles.length + attachedImages.length + (additionalContext.trim() ? 1 : 0) }})
            </span>
          </button>
          <HelpHint topic="cluster.context-input" />
        </div>
        <div v-if="showAdditionalContext">
          <div
            v-if="isCluster"
            class="rounded-lg border-2 transition-colors"
            :class="dragOver ? 'border-primary bg-primary/5 border-solid' : 'border-dashed border-default'"
            @dragover="onDragOver"
            @dragleave="onDragLeave"
            @drop="onDrop"
          >
            <UTextarea
              v-model="additionalContext"
              placeholder="e.g. We deployed a new auth middleware yesterday…"
              :rows="3"
              class="w-full text-sm border-0 bg-transparent focus:ring-0"
            />
            <div class="flex items-center gap-2 px-3 pb-2 pt-1 border-t border-default">
              <input
                ref="fileInputRef"
                type="file"
                multiple
                class="hidden"
                accept=".txt,.log,.md,.json,.ts,.js,.py,.sql,.xml,.yaml,.yml,.html,.css,.env,image/*"
                @change="processFiles(($event.target as HTMLInputElement).files!)"
              />
              <UButton
                icon="i-lucide-paperclip"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="fileInputRef?.click()"
              >
                Attach files
              </UButton>
              <span v-if="dragOver" class="text-xs text-primary">Drop files here…</span>
              <span v-else class="text-xs text-gray-400">or drag &amp; drop text files and images</span>
            </div>
          </div>
          <UTextarea
            v-else
            v-model="additionalContext"
            placeholder="e.g. We deployed a new auth middleware yesterday…"
            :rows="3"
            class="w-full text-sm"
          />
        </div>
      </div>

      <!-- Attached text files (cluster scope) -->
      <div v-if="isCluster && attachedFiles.length" class="flex flex-wrap gap-2">
        <div
          v-for="(f, i) in attachedFiles"
          :key="i"
          class="flex items-center gap-1.5 bg-elevated rounded-full px-2.5 py-1 text-xs border border-default"
        >
          <UIcon name="i-lucide-file-text" class="size-3 text-gray-500 shrink-0" />
          <span class="max-w-40 truncate">{{ f.name }}</span>
          <span class="text-gray-400">{{ formatBytes(f.size) }}</span>
          <button class="text-gray-400 hover:text-error ml-0.5" @click="removeFile(i)">
            <UIcon name="i-lucide-x" class="size-3" />
          </button>
        </div>
      </div>

      <!-- Attached images (cluster scope) -->
      <div v-if="isCluster && attachedImages.length" class="flex flex-wrap gap-2">
        <div v-for="(img, i) in attachedImages" :key="i" class="relative group">
          <img :src="img.preview" :alt="img.name" class="h-16 w-16 object-cover rounded-lg border border-default" />
          <div
            class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center"
          >
            <button class="text-white" @click="removeImage(i)">
              <UIcon name="i-lucide-x" class="size-4" />
            </button>
          </div>
          <p class="text-xs text-gray-500 text-center mt-0.5 w-16 truncate">{{ img.name }}</p>
        </div>
      </div>

      <!-- Screenshots from test evidence (cluster scope, auto-loaded) -->
      <DiagnosisScreenshots
        v-if="isCluster && affectedTestCases?.length"
        :affected-test-cases="affectedTestCases"
        @update:images="testCaseImages = $event"
      />

      <!-- Diagnose button -->
      <div v-if="showDiagnoseButton()" class="pt-1">
        <UButton
          icon="i-lucide-sparkles"
          size="sm"
          color="primary"
          variant="solid"
          :loading="posting"
          data-tour="diagnose-with-ai"
          @click="diagnose(diagnosis?.status === 'running')"
        >
          {{ diagnosis?.status === 'running' ? 'Restart diagnosis' : 'Diagnose with AI' }}
        </UButton>
      </div>

      <!-- Execution scope: a diagnosis is genuinely in flight (this or another session) -->
      <div
        v-if="showRunning"
        class="flex items-center justify-between gap-2 rounded-lg border border-default bg-elevated/40 p-2.5"
      >
        <span class="inline-flex items-center gap-2 text-sm text-gray-500">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary shrink-0" />
          Diagnosis in progress…
        </span>
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :loading="refreshingDiagnosis"
          @click="refreshRunningDiagnosis"
        >
          Refresh
        </UButton>
      </div>

      <!-- Live thinking panel while streaming (cluster scope) -->
      <div v-if="isStreaming()" class="rounded-lg border border-default overflow-hidden">
        <div class="flex items-center justify-between gap-2 px-3 py-2 bg-elevated/30 border-b border-default">
          <div class="flex items-center gap-2 text-sm text-gray-500">
            <UIcon name="i-lucide-loader-2" class="size-4 animate-spin text-primary" />
            <span>Analyzing failure cluster</span>
            <span v-if="streamStage" class="inline-flex items-center gap-1 text-xs text-gray-400">
              <UIcon name="i-lucide-workflow" class="size-3" />
              {{ streamStage === 'research' ? 'Researching patterns' : 'Diagnosing root cause' }}
            </span>
          </div>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            title="Cancel diagnosis"
            @click="streaming?.cancel()"
          />
        </div>
        <div
          ref="thinkingContainer"
          class="max-h-64 overflow-y-auto p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words text-gray-600 dark:text-gray-400 bg-elevated/10"
        >
          <template v-if="streamThinkingText">
            {{ streamThinkingText }}
            <span class="inline-block w-2 h-4 bg-primary/60 animate-pulse ml-0.5 align-text-bottom" />
          </template>
          <template v-else>
            <span class="text-gray-400 italic">Waiting for model response…</span>
          </template>
        </div>
        <div class="px-3 py-1.5 border-t border-default text-xs text-gray-400 flex items-center gap-2">
          <UIcon name="i-lucide-file-text" class="size-3" />
          <span>{{ streamThinkingText.length.toLocaleString() }} characters received</span>
        </div>
      </div>

      <!-- Stuck diagnosis: running from DB but not actively streaming (cluster scope) -->
      <div
        v-if="isCluster && diagnosis?.status === 'running' && !isStale(diagnosis) && !isStreaming()"
        class="rounded-lg border border-warning/40 bg-warning/5 p-3 space-y-2"
      >
        <div class="flex items-center gap-2 text-sm">
          <UIcon name="i-lucide-alert-triangle" class="size-4 text-warning shrink-0" />
          <span class="font-medium text-warning-700 dark:text-warning-400">Diagnosis was interrupted</span>
        </div>
        <p class="text-xs text-gray-500">
          A previous diagnosis started but never completed — the server may have restarted. You can restart it below.
        </p>
        <div class="flex items-center gap-2 pt-1">
          <UButton
            v-if="canRun"
            icon="i-lucide-refresh-cw"
            size="xs"
            color="warning"
            variant="solid"
            :loading="posting"
            @click="diagnose(true)"
          >
            Restart diagnosis
          </UButton>
          <UButton size="xs" color="neutral" variant="ghost" :loading="posting" @click="markDiagnosisFailed">
            Dismiss
          </UButton>
        </div>
        <p class="text-xs text-gray-400">Started {{ formatRelativeTime(diagnosis.updatedAt) }}</p>
      </div>

      <!-- Streaming error banner -->
      <UAlert
        v-if="streamError"
        color="error"
        icon="i-lucide-alert-circle"
        title="Streaming diagnosis failed"
        :description="streamError"
        class="mt-2"
      >
        <template #actions>
          <UButton size="xs" color="neutral" variant="outline" @click="diagnoseFallback(true)">
            Retry (fallback)
          </UButton>
        </template>
      </UAlert>
    </template>

    <!-- Result — rendered whether or not a provider is configured. -->
    <DiagnosisResult
      v-if="showResult()"
      data-shot="diagnosis-result"
      :diagnosis="diagnosis"
      :last-seen-run-id="lastSeenRunId"
      :stale="diagnosisStale"
      :stale-reason="staleReason"
      @view-section="onViewSection"
      @prefill-context="onPrefillContext"
    />

    <!-- AI not configured: one line, and only when there is no result to show.
         Under a stored result the header carries "Re-diagnose (configure AI)". -->
    <div
      v-if="!aiStatus?.configured && !showResult()"
      class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted"
    >
      <span class="inline-flex items-center gap-1">
        <UIcon name="i-lucide-sparkles" class="size-3.5 shrink-0" />
        AI is not configured
        <HelpHint topic="cluster.ai-setup" />
      </span>
      <span aria-hidden="true">·</span>
      <NuxtLink to="/settings/ai" class="text-primary hover:underline">Configure</NuxtLink>
      <span aria-hidden="true">·</span>
      <CopyAiPromptButton :context-endpoint="contextEndpoint" />
    </div>

    <!-- MCP link -->
    <div class="pt-1 text-center">
      <NuxtLink
        to="/mcp"
        class="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-primary transition-colors"
      >
        <UIcon name="i-lucide-bot" class="size-3" />
        Query this {{ isCluster ? 'cluster' : 'failure' }} from your AI agent via the MCP server
      </NuxtLink>
    </div>

    <DiagnosisHistorySlideover
      v-if="isCluster && clusterId"
      :open="showHistory"
      :cluster-id="clusterId"
      :current-diagnosis="diagnosis"
      @update:open="showHistory = $event"
    />
  </div>
</template>
