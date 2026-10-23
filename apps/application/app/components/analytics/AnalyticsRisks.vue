<script setup lang="ts">
import type { AnalyticsRisks } from '#shared/analytics/types';
import { sentencesFor } from '#shared/reports/sentences';

const props = defineProps<{ query: Record<string, string>; title?: string }>();

const { data: risks, pending, error, refresh } = await useAnalyticsWidget<AnalyticsRisks>('risks', () => props.query);

const lines = computed(() => (risks.value ? sentencesFor('en').risks(risks.value, metricFormatter()) : []));
</script>

<template>
  <SectionCard
    icon="i-lucide-triangle-alert"
    :title="title ?? 'Risks'"
    :count="lines.length || undefined"
    help="analytics.risks"
    data-tour="analytics-risks"
    data-shot="analytics-risks"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the risks: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="lines.length === 0" icon="i-lucide-check-circle" text="No risk stands out in this period." />
    <ul v-else class="space-y-1.5">
      <li v-for="line in lines" :key="line" class="text-sm text-highlighted leading-relaxed">{{ line }}</li>
    </ul>
  </SectionCard>
</template>
