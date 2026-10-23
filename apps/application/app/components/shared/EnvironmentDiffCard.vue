<script setup lang="ts">
/**
 * Environment diff between a failing execution and the same test's last
 * passing execution. Self-contained: fetches the diff for a test-run case and
 * renders only the changed keys as stacked rows (mobile-safe, no table). Used
 * on the test-case detail page and the cluster evidence tabs.
 */

import type { EnvironmentDiffEntry } from '#shared/environment-diff';
import SectionCard from './SectionCard.vue';
import CollapsibleSectionCard from './CollapsibleSectionCard.vue';

const props = defineProps<{
  runId: number;
  testRunsCaseId: number;
  /** When set, the card folds to a header with a peek (persisted per user). */
  storageKey?: string;
  /** Drop the card frame and padding — render a plain heading row over the body. */
  embedded?: boolean;
}>();

interface EnvironmentDiffResponse {
  status: 'ok' | 'no-baseline' | 'not-found';
  baseline?: { runId: number; executionId: number; startTime: number | null; environment?: string | null };
  /** Set when the baseline came from another environment than the failing run. */
  baselineNote?: string | null;
  entries?: EnvironmentDiffEntry[];
}

const cardComponent = computed(() =>
  props.embedded ? SectionCard : props.storageKey ? CollapsibleSectionCard : SectionCard,
);
const cardBind = computed(() =>
  props.embedded ? { embedded: true } : props.storageKey ? { storageKey: props.storageKey } : {},
);

const {
  data: diff,
  pending,
  error,
} = useFetch<EnvironmentDiffResponse>(() => `/api/test-run-cases/${props.testRunsCaseId}/environment-diff`, {
  lazy: true,
});

const available = computed(() => !pending.value && !error.value && diff.value?.status === 'ok');

const entries = computed<EnvironmentDiffEntry[]>(() => diff.value?.entries ?? []);
const meaningful = computed(() => entries.value.filter((e) => !e.informational));
const informational = computed(() => entries.value.filter((e) => e.informational));

const baselineNote = computed(() => {
  const b = diff.value?.baseline;
  if (!b) return '';
  const when = b.startTime ? ` · ${formatRelativeTime(new Date(b.startTime))}` : '';
  const note = diff.value?.baselineNote ? ` · ${diff.value.baselineNote}` : '';
  return `vs last passing run of this test (run #${b.runId}${when})${note}`;
});

const foldedText = computed(() => {
  if (diff.value?.status !== 'ok') return 'No passing baseline to compare against';
  const n = meaningful.value.length;
  if (n === 0) return 'Identical to last pass — no environment drift';
  return `${n} change${n === 1 ? '' : 's'}: ${meaningful.value.map((e) => e.label).join(', ')}`;
});

// Forward reveal so a diagnosis citation can unfold + scroll to this card.
const card = ref<{ reveal?: () => void } | null>(null);
defineExpose({ reveal: () => card.value?.reveal?.() });
</script>

<template>
  <component
    :is="cardComponent"
    v-if="available && diff"
    ref="card"
    v-bind="cardBind"
    icon="i-lucide-git-compare-arrows"
    title="Environment diff"
    :count="meaningful.length || undefined"
    help="environment-diff"
    :subtitle="baselineNote"
    data-tour="environment-diff"
  >
    <template v-if="storageKey" #folded>
      <span>{{ foldedText }}</span>
    </template>

    <!-- Identical environment — positive evidence, worth stating explicitly -->
    <UAlert
      v-if="entries.length === 0"
      color="success"
      icon="i-lucide-check-circle"
      variant="subtle"
      description="The environment is identical to the last passing run — environment drift is unlikely to explain this failure."
    />

    <div v-else class="space-y-2">
      <!-- Which side is which: the failing run on the left, its last pass on the right -->
      <div class="flex items-center gap-1.5 text-xs font-medium px-3">
        <span class="hidden sm:block sm:w-40 shrink-0" aria-hidden="true" />
        <span class="text-red-700 dark:text-red-400">This run</span>
        <UIcon name="i-lucide-arrow-left" class="size-3 shrink-0 text-gray-400" />
        <span class="text-green-700 dark:text-green-400">Last pass, run #{{ diff?.baseline?.runId }}</span>
      </div>
      <div
        v-for="entry in meaningful"
        :key="entry.key"
        class="rounded-lg border border-default p-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3"
      >
        <span class="text-xs font-medium text-gray-500 dark:text-gray-400 sm:w-40 shrink-0">{{ entry.label }}</span>
        <div class="flex flex-wrap items-center gap-1.5 min-w-0 text-xs font-mono">
          <code class="rounded bg-red-50 px-1.5 py-0.5 text-red-700 dark:bg-red-950/30 dark:text-red-400 break-all">
            {{ entry.failing ?? '(unset)' }}
          </code>
          <UIcon name="i-lucide-arrow-left" class="size-3 shrink-0 text-gray-400" />
          <code
            class="rounded bg-green-50 px-1.5 py-0.5 text-green-700 dark:bg-green-950/30 dark:text-green-400 break-all"
          >
            {{ entry.baseline ?? '(unset)' }}
          </code>
        </div>
      </div>

      <!-- Worker/shard placement varies naturally between runs — de-emphasized -->
      <p v-if="informational.length > 0" class="text-xs text-gray-400 dark:text-gray-500">
        Also changed (varies naturally between runs):
        <span v-for="(entry, i) in informational" :key="entry.key">
          {{ entry.label.toLowerCase() }} {{ entry.baseline ?? '—' }} → {{ entry.failing ?? '—'
          }}<span v-if="i < informational.length - 1">, </span>
        </span>
      </p>
    </div>
  </component>
</template>
