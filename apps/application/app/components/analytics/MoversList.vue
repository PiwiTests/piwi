<script setup lang="ts">
import type { AnalyticsMover, AnalyticsMoverKind, AnalyticsMovers } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const {
  data: movers,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsMovers>(
  'movers',
  () => props.query,
  () => props.options,
);

const f = computed(() => metricFormatter());
const groups = computed(() => movers.value?.groups ?? []);

/** Worse news in the failed color, better news in the passed color. */
const KIND_CLASS: Record<AnalyticsMoverKind, string> = {
  'became-flaky': STATUS_PALETTE.failed.text,
  slower: STATUS_PALETTE.failed.text,
  'stopped-flaky': STATUS_PALETTE.passed.text,
  faster: STATUS_PALETTE.passed.text,
};

function change(kind: AnalyticsMoverKind, m: AnalyticsMover): string {
  if (kind === 'slower' || kind === 'faster') {
    return `${f.value.value(m.before, 'ms', 0)} → ${f.value.value(m.after, 'ms', 0)} (${m.changePct! > 0 ? '+' : ''}${m.changePct}%)`;
  }
  return `flaky in ${Math.round(m.before * 100)}% → ${Math.round(m.after * 100)}% of executions`;
}
</script>

<template>
  <SectionCard
    icon="i-lucide-arrow-up-down"
    :title="title ?? 'Movers'"
    :subtitle="movers?.comparisonLabel ? `Against ${movers.comparisonLabel.toLowerCase()}` : undefined"
    help="analytics.movers"
    data-tour="analytics-movers"
    data-shot="analytics-movers"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the movers: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState
      v-else-if="movers && !movers.comparisonLabel"
      text="Movers need a comparison period: pick one in the scope bar."
    />
    <EmptyState v-else-if="groups.length === 0" text="No test moved against the comparison period." />
    <div v-else class="grid gap-4 lg:grid-cols-2">
      <section v-for="group in groups" :key="group.kind" class="space-y-1" :data-testid="`movers-${group.kind}`">
        <h4 class="text-xs font-medium text-muted">{{ group.label }} ({{ group.items.length }})</h4>
        <ul class="divide-y divide-default">
          <li v-for="m in group.items" :key="m.testCaseId" class="py-1.5 min-w-0">
            <NuxtLink
              :to="`/test-cases/${m.testCaseId}`"
              class="block text-sm text-highlighted truncate hover:text-primary"
              :title="m.title"
            >
              {{ m.title }}
            </NuxtLink>
            <p class="text-xs text-muted truncate">
              {{ m.projectName }} · <span :class="KIND_CLASS[group.kind]">{{ change(group.kind, m) }}</span>
            </p>
          </li>
        </ul>
      </section>
    </div>
  </SectionCard>
</template>
