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
  /** A restart or a clock offset of the failing run's servers under test. */
  serverNotes?: string[];
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
const serverNotes = computed(() => diff.value?.serverNotes ?? []);

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
  if (n === 0 && serverNotes.value.length > 0) return serverNotes.value[0]!;
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
      v-if="entries.length === 0 && serverNotes.length === 0"
      color="success"
      icon="i-lucide-check-circle"
      variant="subtle"
      description="The environment is identical to the last passing run — environment drift is unlikely to explain this failure."
    />

    <p v-for="note in serverNotes" :key="note" class="text-sm text-highlighted" data-environment-warning>
      {{ note }}
    </p>

    <EnvironmentDiffEntries
      :entries="entries"
      this-label="This run"
      :other-label="`Last pass, run #${diff?.baseline?.runId}`"
    />
  </component>
</template>
