<script setup lang="ts">
import { filterCommits, formatRelativeTime } from '~/utils';
import type { CommitListItem } from '~~/types/api';

const props = defineProps<{
  modelValue: string;
  clusterId: number;
}>();

const emit = defineEmits<{
  'update:modelValue': [string];
}>();

const open = ref(false);
const search = ref('');
const commits = ref<CommitListItem[]>([]);
const apiError = ref<string | null>(null);
const aggregateStats = ref<{ filesChanged: number; linesAdded: number; linesRemoved: number } | null>(null);
const loading = ref(false);
const fetchError = ref(false);
const searchInputRef = ref<{ $el?: HTMLElement } | null>(null);
const loadedForBaseline = ref<string | null>(null);

const branches = ref<string[]>([]);
const branchesLoading = ref(false);
const selectedBranch = ref<string | undefined>(undefined);

const selected = computed((): CommitListItem | null => {
  if (!props.modelValue) return null;
  const sha = props.modelValue.trim();
  const found = commits.value.find((c) => c.sha === sha || c.sha.startsWith(sha));
  return found ?? { sha, shortSha: sha.slice(0, 7), message: '', author: '', date: '' };
});

async function loadBranches() {
  if (branches.value.length) return;
  branchesLoading.value = true;
  try {
    const res = await $fetch<{ items: string[] }>(`/api/failure-clusters/${props.clusterId}/branches`);
    branches.value = res.items;
  } catch {
    // ignore branch load failures
  } finally {
    branchesLoading.value = false;
  }
}

async function loadCommits() {
  const baseline = props.modelValue || '';
  loading.value = true;
  fetchError.value = false;
  loadedForBaseline.value = null;
  try {
    const params: { baseline?: string; branch?: string } = {};
    if (baseline) params.baseline = baseline;
    if (selectedBranch.value) params.branch = selectedBranch.value;
    const res = await $fetch<{
      items: CommitListItem[];
      aggregate: { filesChanged: number; linesAdded: number; linesRemoved: number } | null;
      error?: string | null;
    }>(`/api/failure-clusters/${props.clusterId}/commits`, { query: params });
    commits.value = res.items;
    aggregateStats.value = res.aggregate;
    apiError.value = res.error ?? null;
    loadedForBaseline.value = baseline;
  } catch {
    fetchError.value = true;
  } finally {
    loading.value = false;
  }
}

watch(selectedBranch, () => {
  commits.value = [];
  loadedForBaseline.value = null;
  loadCommits();
});

watch(open, async (val) => {
  if (val) {
    await Promise.all([loadBranches(), loadCommits()]);
    await nextTick();
    const input = searchInputRef.value?.$el?.querySelector('input') ?? searchInputRef.value?.$el;
    if (input instanceof HTMLElement) input.focus();
  } else {
    search.value = '';
  }
});

const filtered = computed(() => filterCommits(commits.value, search.value));

// When search looks like a SHA not already in list, offer a manual-use option
const manualSha = computed(() => {
  const q = search.value.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(q)) return null;
  if (filtered.value.some((c) => c.sha.startsWith(q.toLowerCase()))) return null;
  return q;
});

function select(sha: string) {
  emit('update:modelValue', sha);
  open.value = false;
}

function clear(e: Event) {
  e.stopPropagation();
  apiError.value = null;
  aggregateStats.value = null;
  emit('update:modelValue', '');
  open.value = false;
}
</script>

<template>
  <UPopover v-model:open="open">
    <UButton
      size="xs"
      color="neutral"
      variant="outline"
      :icon="modelValue ? 'i-lucide-git-branch-plus' : 'i-lucide-git-branch'"
      trailing-icon="i-lucide-chevron-down"
      class="min-w-36 max-w-48 font-mono"
    >
      <span v-if="selected?.message" class="flex items-center gap-1.5 overflow-hidden min-w-0">
        <code class="text-primary shrink-0">{{ selected.shortSha }}</code>
        <span class="text-gray-500 truncate text-xs font-sans">{{ selected.message }}</span>
      </span>
      <span v-else-if="modelValue" class="text-primary text-xs">{{ modelValue.slice(0, 7) }}…</span>
      <span v-else class="text-gray-400 font-sans text-xs">baseline commit…</span>
    </UButton>

    <template #content>
      <div class="w-96 p-2 space-y-2">
        <!-- Branch selector -->
        <div class="flex items-center gap-1">
          <UIcon name="i-lucide-git-branch" class="size-3.5 text-gray-400 shrink-0" />
          <USelectMenu
            v-model="selectedBranch"
            :items="branches"
            placeholder="Default branch"
            size="xs"
            class="flex-1"
            :loading="branchesLoading"
            :disabled="branchesLoading"
          />
        </div>

        <!-- Search bar + clear -->
        <div class="flex items-center gap-1">
          <UInput
            ref="searchInputRef"
            v-model="search"
            placeholder="Search message, author, SHA…"
            size="xs"
            icon="i-lucide-search"
            class="flex-1"
          />
          <UButton
            v-if="modelValue"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            title="Clear baseline"
            @click="clear($event)"
          />
        </div>

        <!-- Aggregate stats for the selected baseline -->
        <div
          v-if="aggregateStats && modelValue && !loading"
          class="flex items-center gap-2 px-2 py-1.5 text-xs rounded-md bg-primary/5 text-gray-600 dark:text-gray-300"
        >
          <UIcon name="i-lucide-git-compare-arrows" class="size-3.5 shrink-0 text-primary" />
          <span>Since baseline:</span>
          <span class="font-medium text-green-600 dark:text-green-400">+{{ aggregateStats.linesAdded }}</span>
          <span class="font-medium text-red-600 dark:text-red-400">-{{ aggregateStats.linesRemoved }}</span>
          <span class="text-gray-400"
            >across {{ aggregateStats.filesChanged }} file{{ aggregateStats.filesChanged === 1 ? '' : 's' }}</span
          >
        </div>

        <!-- Loading -->
        <div v-if="loading" class="flex items-center justify-center gap-2 py-6 text-gray-400">
          <UIcon name="i-lucide-loader-2" class="size-4 animate-spin" />
          <span class="text-sm">Loading commits…</span>
        </div>

        <!-- Error (network or API) -->
        <div v-else-if="fetchError" class="py-4 text-center text-sm text-red-500">
          Failed to load commits — check the SCM credential in the project’s Source control settings
        </div>

        <!-- API diagnostic warning (empty list due to rate limit, auth, etc.) -->
        <div
          v-else-if="apiError && !loading && commits.length === 0"
          class="flex items-start gap-2 px-2 py-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-md"
        >
          <UIcon name="i-lucide-triangle-alert" class="size-3.5 shrink-0 mt-0.5" />
          <span>{{ apiError }}</span>
        </div>

        <!-- List -->
        <div v-else class="max-h-80 overflow-y-auto space-y-px">
          <!-- Manual SHA option when search looks like an unlisted SHA -->
          <button
            v-if="manualSha"
            class="w-full text-left px-2 py-1.5 rounded flex items-center gap-2 hover:bg-elevated transition-colors border border-dashed border-default"
            @click="select(manualSha)"
          >
            <UIcon name="i-lucide-git-commit-horizontal" class="size-3.5 text-gray-400 shrink-0" />
            <span class="text-xs text-gray-500">Use commit</span>
            <code class="text-xs text-primary">{{ manualSha.slice(0, 7) }}</code>
          </button>

          <!-- No results -->
          <div v-if="filtered.length === 0 && !manualSha" class="py-4 text-center text-sm text-gray-400">
            {{ search ? 'No commits match' : 'No commits available' }}
          </div>

          <!-- Commit rows -->
          <button
            v-for="c in filtered"
            :key="c.sha"
            class="w-full text-left px-2 py-1.5 rounded flex items-start gap-2 hover:bg-elevated transition-colors"
            :class="modelValue === c.sha ? 'bg-primary/10 ring-1 ring-inset ring-primary/30' : ''"
            @click="select(c.sha)"
          >
            <code class="text-xs text-primary shrink-0 w-14 pt-px">{{ c.shortSha }}</code>
            <div class="flex-1 min-w-0">
              <p class="text-xs font-medium leading-snug truncate">
                {{ c.message }}
              </p>
              <p class="text-xs text-gray-400 leading-snug truncate">
                {{ c.author }}<template v-if="c.date"> · {{ formatRelativeTime(c.date) }} </template>
              </p>
            </div>
            <UIcon v-if="modelValue === c.sha" name="i-lucide-check" class="size-3.5 text-primary shrink-0 mt-0.5" />
          </button>
        </div>
      </div>
    </template>
  </UPopover>
</template>
