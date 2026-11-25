<script setup lang="ts">
/**
 * Diagnosis version history for a cluster, in a slide-over: every prior version
 * newest-first with the current diagnosis on top. Selecting one renders it
 * read-only through `DiagnosisResult`, with a "version from <date>" banner and a
 * one-line summary of what changed since it.
 *
 * The list is fetched once with `?full=1`, so each version carries its own
 * `details` and can be shown in full without another round-trip.
 */
import type { FailureDiagnosis } from '~~/server/database/schema';
import { diagnosisAuthorLabel } from '#shared/agent-diagnosis';
import { storedPatchValidation } from '#shared/patch';
import { formatRelativeTime, prettyDateFormat } from '~/utils';

const props = defineProps<{
  open: boolean;
  clusterId: number;
  /** The live diagnosis, shown as the newest entry. */
  currentDiagnosis: FailureDiagnosis | null;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

interface VersionItem {
  id: number;
  status: string;
  category: string | null;
  confidence: string | null;
  summary: string | null;
  rootCause: string | null;
  provider?: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  feedback: string | null;
  createdAt: string;
  details?: unknown;
  feedbackNote?: string | null;
}

const versions = ref<VersionItem[]>([]);
const loading = ref(false);
const loaded = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await $fetch<{ items: VersionItem[] }>(`/api/failure-clusters/${props.clusterId}/diagnoses`, {
      query: { full: '1' },
    });
    versions.value = res.items;
    loaded.value = true;
  } catch {
    versions.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open && !loaded.value) load();
  },
);

/** One entry per diagnosis state: the live one, then every snapshot. */
interface Entry {
  key: string;
  current: boolean;
  createdAt: string | Date;
  diagnosis: FailureDiagnosis;
}

/** Fill a version (or the live row) out to a full FailureDiagnosis for the read-only result. */
function toDiagnosis(v: VersionItem): FailureDiagnosis {
  return {
    id: v.id,
    clusterId: props.clusterId,
    scope: 'cluster',
    testRunsCaseId: null,
    contextSha: null,
    status: v.status,
    provider: v.provider ?? null,
    model: v.model,
    category: v.category,
    confidence: v.confidence,
    summary: v.summary,
    rootCause: v.rootCause,
    details: v.details ?? null,
    error: null,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    durationMs: v.durationMs,
    feedback: v.feedback,
    feedbackNote: v.feedbackNote ?? null,
    createdAt: new Date(v.createdAt),
    updatedAt: new Date(v.createdAt),
  } as FailureDiagnosis;
}

const entries = computed<Entry[]>(() => {
  const list: Entry[] = [];
  const cur = props.currentDiagnosis;
  if (cur && cur.status === 'completed') {
    list.push({ key: `current-${cur.id}`, current: true, createdAt: cur.updatedAt, diagnosis: cur });
  }
  for (const v of versions.value) {
    list.push({ key: `v-${v.id}`, current: false, createdAt: v.createdAt, diagnosis: toDiagnosis(v) });
  }
  return list;
});

const selectedKey = ref<string | null>(null);
watch(entries, (list) => {
  if (list.length && (!selectedKey.value || !list.some((e) => e.key === selectedKey.value))) {
    selectedKey.value = list[0]!.key;
  }
});

const selectedIndex = computed(() => entries.value.findIndex((e) => e.key === selectedKey.value));
const selected = computed(() => entries.value[selectedIndex.value] ?? null);

/** Read the patch-validation status stored on a diagnosis, when present. */
function patchStatus(d: FailureDiagnosis): string | null {
  return storedPatchValidation(d.details)?.status ?? null;
}

/** One-line summary of what changed between a version and the one that superseded it. */
const whatChanged = computed<string | null>(() => {
  const idx = selectedIndex.value;
  if (idx < 0) return null;
  if (idx === 0) return 'Current diagnosis — nothing supersedes it.';
  const older = entries.value[idx]!.diagnosis;
  const newer = entries.value[idx - 1]!.diagnosis;
  const changes: string[] = [];
  if (older.category !== newer.category) changes.push(`category ${older.category ?? '—'} → ${newer.category ?? '—'}`);
  if (older.confidence !== newer.confidence)
    changes.push(`confidence ${older.confidence ?? '—'} → ${newer.confidence ?? '—'}`);
  if ((older.rootCause ?? '') !== (newer.rootCause ?? '')) changes.push('root cause revised');
  const op = patchStatus(older);
  const np = patchStatus(newer);
  if (op !== np) changes.push(`patch ${op ?? 'none'} → ${np ?? 'none'}`);
  return changes.length
    ? `Since this version: ${changes.join(' · ')}.`
    : 'No change to category, confidence, root cause or patch since this version.';
});

const feedbackIcon = (f: string | null) =>
  f === 'up' ? 'i-lucide-thumbs-up' : f === 'down' ? 'i-lucide-thumbs-down' : null;
</script>

<template>
  <USlideover
    :open="open"
    title="Diagnosis history"
    :ui="{ content: 'sm:max-w-3xl' }"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <LoadingState v-if="loading && !entries.length" text="Loading history…" />
      <EmptyState
        v-else-if="!entries.length"
        icon="i-lucide-history"
        text="Versions appear here once this cluster has been re-diagnosed at least once."
      />
      <div v-else class="grid grid-cols-1 md:grid-cols-[16rem_1fr] gap-4">
        <!-- Version list -->
        <ul class="space-y-1.5 md:max-h-[calc(100vh-8rem)] md:overflow-y-auto md:pr-1">
          <li v-for="(e, i) in entries" :key="e.key">
            <button
              class="w-full text-left rounded-lg border px-3 py-2 transition-colors"
              :class="
                e.key === selectedKey
                  ? 'border-primary bg-primary/5'
                  : 'border-default hover:border-primary/50 hover:bg-elevated/40'
              "
              @click="selectedKey = e.key"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-medium">
                  <span v-if="e.current" class="text-primary">Current</span>
                  <span v-else>v{{ entries.length - i }}</span>
                </span>
                <UIcon
                  v-if="feedbackIcon(e.diagnosis.feedback)"
                  :name="feedbackIcon(e.diagnosis.feedback)!"
                  class="size-3.5 shrink-0"
                  :class="e.diagnosis.feedback === 'up' ? 'text-emerald-500' : 'text-rose-500'"
                />
              </div>
              <ClientOnly>
                <p class="text-xs text-gray-500 mt-0.5" :title="prettyDateFormat(e.createdAt)">
                  {{ formatRelativeTime(e.createdAt) }}
                </p>
              </ClientOnly>
              <div class="flex flex-wrap items-center gap-1 mt-1">
                <UBadge v-if="e.diagnosis.category" color="neutral" variant="subtle" size="sm">
                  {{ e.diagnosis.category }}
                </UBadge>
                <UBadge v-if="e.diagnosis.confidence" color="neutral" variant="outline" size="sm">
                  {{ e.diagnosis.confidence }}
                </UBadge>
              </div>
              <p class="text-xs text-gray-400 mt-1 truncate">
                {{ diagnosisAuthorLabel(e.diagnosis.provider, e.diagnosis.model) }}
                <template v-if="e.diagnosis.inputTokens != null || e.diagnosis.outputTokens != null">
                  · {{ (e.diagnosis.inputTokens ?? 0) + (e.diagnosis.outputTokens ?? 0) }} tokens
                </template>
              </p>
            </button>
          </li>
        </ul>

        <!-- Selected version -->
        <div v-if="selected" class="min-w-0 space-y-3">
          <UAlert
            :color="selected.current ? 'primary' : 'neutral'"
            variant="subtle"
            :icon="selected.current ? 'i-lucide-circle-dot' : 'i-lucide-history'"
          >
            <template #title>
              <ClientOnly>
                <span v-if="selected.current">Current diagnosis</span>
                <span v-else>Version from {{ prettyDateFormat(selected.createdAt) }}</span>
              </ClientOnly>
            </template>
            <template #description>
              <span>{{ whatChanged }}</span>
            </template>
          </UAlert>
          <DiagnosisResult :diagnosis="selected.diagnosis" read-only />
        </div>
      </div>
    </template>
  </USlideover>
</template>
