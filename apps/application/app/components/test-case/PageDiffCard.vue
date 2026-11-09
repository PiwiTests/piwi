<script setup lang="ts">
/**
 * Structural page diff between a failing execution and the same test's last
 * green ARIA sample. Self-contained: fetches the diff for a test-run case, then
 * renders a compact hunk list — added, removed, renamed, changed and moved
 * nodes, unchanged subtrees collapsed, the failing locator's node highlighted.
 * When no diff can be produced it shows the three-state evidence empty copy.
 */
import type { PageDiff } from '~~/types/api';
import { formatPageDiffSummary } from '#shared/page-diff';
import type { EvidenceState } from '#shared/evidence-state';
import SectionCard from '../shared/SectionCard.vue';
import PageDiffHunkList from './PageDiffHunkList.vue';

const props = defineProps<{
  runId: number;
  testRunsCaseId: number;
  /** Drop the card chrome when embedded inside an evidence tab panel. */
  embedded?: boolean;
}>();

const {
  data: diff,
  pending,
  error,
} = useFetch<PageDiff>(() => `/api/test-run-cases/${props.testRunsCaseId}/page-diff`, { lazy: true });

// The page/tab reads `available` to show the Screenshot · Page diff toggle for
// exactly the condition under which a diff renders.
const emit = defineEmits<{ available: [value: boolean] }>();
const available = computed(() => !pending.value && !error.value && diff.value?.status === 'ok');
watch(available, (value) => emit('available', value), { immediate: true });

const summaryText = computed(() => (diff.value?.summary ? formatPageDiffSummary(diff.value.summary) : ''));
const hunks = computed(() => diff.value?.hunks ?? []);

const baselineLine = computed(() => {
  const b = diff.value?.baseline;
  if (!b) return '';
  const commit = b.commit ? ` on ${b.commit.slice(0, 7)}` : '';
  const when = b.at ? `, ${formatRelativeTime(new Date(b.at))}` : '';
  return `vs last green — run #${b.runId}${commit}${when}`;
});

// The empty copy for the three typed reasons a diff can't be produced.
const emptyState = computed<EvidenceState | null>(() => {
  switch (diff.value?.status) {
    case 'no-failure-snapshot':
      return {
        state: 'not-captured',
        title: 'Page diff',
        description: 'The failing page was not captured for this run — add the capture fixtures.',
        to: '/settings/connect',
        toLabel: 'Open setup',
      };
    case 'no-green-sample':
      return {
        state: 'nothing-happened',
        title: 'Page diff',
        description: 'No green sample yet — a baseline appears after the next passing run of this test.',
      };
    case 'not-applicable':
    case 'not-found':
      return {
        state: 'not-applicable',
        title: 'Page diff',
        description: 'A page diff needs a failing ARIA snapshot to compare — not applicable here.',
      };
    default:
      return null;
  }
});
</script>

<template>
  <SectionCard :embedded="embedded" icon="i-lucide-file-diff" title="Page diff" help="case.page-diff">
    <template v-if="available && diff?.baseline" #subtitle>
      <span
        >{{ baselineLine }}<template v-if="diff.baselineNote"> · {{ diff.baselineNote }}</template></span
      >
    </template>
    <template v-if="available" #actions>
      <UBadge color="neutral" variant="subtle" size="sm" class="font-mono tabular-nums">{{ summaryText }}</UBadge>
    </template>

    <LoadingState v-if="pending" text="Comparing against the last green page…" />

    <template v-else-if="available">
      <!-- No structural change is positive evidence — state it explicitly. -->
      <UAlert
        v-if="hunks.length === 0"
        color="success"
        icon="i-lucide-check-circle"
        variant="subtle"
        description="The page structure is identical to the last passing run — a structural change is unlikely to explain this failure."
      />

      <PageDiffHunkList v-else :hunks="hunks" />
    </template>

    <EvidenceEmptyState v-else-if="emptyState" :state="emptyState" doc="/evidence" compact />
  </SectionCard>
</template>
