<script setup lang="ts">
/**
 * Pending cluster-merge suggestions for a project. Each is a pair the
 * embedding reconciler / LLM adjudicator flagged as probably-the-same root cause
 * but didn't auto-merge. The holders of `triage:write` on the project, the
 * permission both routes declare, approve (→ merge) or reject; others see the
 * pairs alone.
 */
interface ClusterSummary {
  id: number;
  signature: string;
  errorType: string | null;
  occurrences: number;
  status: string;
}
interface MergeSuggestion {
  id: number;
  score: number | null;
  method: 'embedding' | 'llm';
  llmConfidence: string | null;
  llmReason: string | null;
  status: string;
  createdAt: string;
  clusterA: ClusterSummary | null;
  clusterB: ClusterSummary | null;
}

const props = defineProps<{ projectId: string }>();
const emit = defineEmits<{ merged: [] }>();

const toast = useToast();
const { can } = useAuth();
const canDecide = computed(() => can('triage:write', props.projectId));
const suggestions = ref<MergeSuggestion[]>([]);
const pendingId = ref<number | null>(null);

async function load() {
  try {
    suggestions.value = (
      await $fetch<{ items: MergeSuggestion[] }>(`/api/projects/${props.projectId}/cluster-merge-suggestions`)
    ).items;
  } catch {
    suggestions.value = [];
  }
}

watch(() => props.projectId, load, { immediate: true });

async function act(id: number, action: 'approve' | 'reject') {
  pendingId.value = id;
  try {
    await $fetch(`/api/cluster-merge-suggestions/${id}/${action}`, { method: 'POST' });
    toast.add({ title: action === 'approve' ? 'Clusters merged' : 'Suggestion dismissed', color: 'success' });
    await load();
    if (action === 'approve') emit('merged');
  } catch (e) {
    toast.add({ title: 'Action failed', description: String((e as Error)?.message ?? e), color: 'error' });
  } finally {
    pendingId.value = null;
  }
}

const pct = (s: number | null) => (s == null ? '' : `${Math.round(s * 100)}% similar`);
</script>

<template>
  <SectionCard
    v-if="suggestions.length"
    icon="i-lucide-git-merge"
    title="Suggested merges"
    :count="suggestions.length"
    class="mb-4"
  >
    <template #subtitle>
      Likely-duplicate clusters found by semantic analysis. Approving merges them into the older cluster.
    </template>

    <div class="space-y-3">
      <div
        v-for="s in suggestions"
        :key="s.id"
        class="rounded-lg border border-default p-3 flex items-start justify-between gap-4"
      >
        <div class="min-w-0 space-y-1">
          <div class="flex items-center gap-2 flex-wrap text-sm">
            <UBadge :color="s.method === 'llm' ? 'primary' : 'neutral'" variant="subtle" size="sm">
              {{ s.method === 'llm' ? `AI · ${s.llmConfidence ?? ''}` : 'similarity' }}
            </UBadge>
            <span v-if="pct(s.score)" class="text-gray-500">{{ pct(s.score) }}</span>
          </div>
          <p class="text-sm truncate" :title="s.clusterA?.signature || ''">
            <span class="text-gray-400">A:</span> {{ s.clusterA?.signature || `#${s.id}` }}
          </p>
          <p class="text-sm truncate" :title="s.clusterB?.signature || ''">
            <span class="text-gray-400">B:</span> {{ s.clusterB?.signature || '' }}
          </p>
          <p v-if="s.llmReason" class="text-xs text-gray-500 italic">{{ s.llmReason }}</p>
        </div>
        <div v-if="canDecide" class="flex items-center gap-2 shrink-0">
          <UButton
            size="sm"
            color="primary"
            icon="i-lucide-git-merge"
            :loading="pendingId === s.id"
            @click="act(s.id, 'approve')"
          >
            Merge
          </UButton>
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            :disabled="pendingId === s.id"
            @click="act(s.id, 'reject')"
          >
            Dismiss
          </UButton>
        </div>
      </div>
    </div>
  </SectionCard>
</template>
