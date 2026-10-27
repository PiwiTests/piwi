<script setup lang="ts">
import type { AnalyticsHandbacks } from '#shared/analytics/types';
import { sentencesFor } from '#shared/reports/sentences';

const props = defineProps<{ query: Record<string, string>; title?: string }>();

const { data, pending, error, refresh } = await useAnalyticsWidget<AnalyticsHandbacks>('handbacks', () => props.query);

const lines = computed(() => (data.value ? sentencesFor('en').handbacks(data.value, metricFormatter()) : []));
</script>

<template>
  <SectionCard
    icon="i-lucide-undo-2"
    :title="title ?? 'Hand-back outcomes'"
    help="analytics.handbacks"
    data-tour="analytics-handbacks"
    data-shot="analytics-handbacks"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the hand-back outcomes: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState
      v-else-if="lines.length === 0"
      icon="i-lucide-undo-2"
      text="Nothing Piwi handed back reached an outcome in this period."
    />
    <dl v-else class="grid grid-cols-1 gap-y-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-x-4">
      <template v-for="line in lines" :key="line.label">
        <dt class="text-sm font-semibold text-highlighted leading-relaxed max-sm:-mb-2">{{ line.label }}</dt>
        <dd class="min-w-0 text-sm text-highlighted leading-relaxed">{{ line.text }}</dd>
      </template>
    </dl>
  </SectionCard>
</template>
