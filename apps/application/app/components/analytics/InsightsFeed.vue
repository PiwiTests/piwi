<script setup lang="ts">
import type { AnalyticsInsight, AnalyticsInsightSeverity } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string> }>();

const {
  data: insights,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsInsight[]>('insights', () => props.query);

const NuxtLink = resolveComponent('NuxtLink');

const SEVERITY_META: Record<AnalyticsInsightSeverity, { icon: string; class: string; border: string }> = {
  critical: { icon: 'i-lucide-octagon-alert', class: 'text-red-500', border: 'border-l-red-500' },
  warning: { icon: 'i-lucide-triangle-alert', class: 'text-amber-500', border: 'border-l-amber-400' },
  info: { icon: 'i-lucide-info', class: 'text-blue-500', border: 'border-l-blue-400' },
  positive: { icon: 'i-lucide-trending-up', class: 'text-green-500', border: 'border-l-green-500' },
};
</script>

<template>
  <SectionCard
    icon="i-lucide-lightbulb"
    title="Insights"
    :count="insights?.length || undefined"
    help="analytics.insights"
    data-tour="analytics-insights"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load insights: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState
      v-else-if="!insights || insights.length === 0"
      icon="i-lucide-check-circle"
      text="Nothing needs your attention in this period."
    />
    <div v-else class="divide-y divide-gray-100 dark:divide-gray-800">
      <component
        :is="insight.to ? NuxtLink : 'div'"
        v-for="insight in insights"
        :key="insight.id"
        :to="insight.to"
        class="flex items-start gap-3 py-3 pl-3 border-l-2"
        :class="[
          SEVERITY_META[insight.severity].border,
          insight.to ? 'hover:bg-gray-50 dark:hover:bg-gray-800/60 rounded-r transition-colors' : '',
        ]"
      >
        <UIcon
          :name="SEVERITY_META[insight.severity].icon"
          class="size-4 mt-0.5 shrink-0"
          :class="SEVERITY_META[insight.severity].class"
        />
        <div class="min-w-0">
          <p class="text-sm font-medium">{{ insight.message }}</p>
          <p v-if="insight.detail" class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ insight.detail }}</p>
        </div>
      </component>
    </div>
  </SectionCard>
</template>
