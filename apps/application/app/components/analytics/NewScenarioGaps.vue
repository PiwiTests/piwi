<script setup lang="ts">
import type { AnalyticsNewGaps } from '#shared/analytics/types';
import { sentencesFor } from '#shared/reports/sentences';

const props = defineProps<{ query: Record<string, string>; title?: string }>();

const { data, pending, error, refresh } = await useAnalyticsWidget<AnalyticsNewGaps>('new-gaps', () => props.query);

const s = sentencesFor('en');
</script>

<template>
  <SectionCard
    icon="i-lucide-map-pin-plus"
    :title="title ?? 'New scenario gaps'"
    help="analytics.new-gaps"
    data-tour="analytics-new-gaps"
    data-shot="analytics-new-gaps"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the new scenario gaps: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState
      v-else-if="!data || data.projects === 0"
      icon="i-lucide-map"
      text="The Test Map is not active for the projects in scope."
    />
    <EmptyState
      v-else-if="data.items.length === 0"
      icon="i-lucide-check-circle"
      text="No new scenario gap in this period."
    />
    <div v-else class="space-y-3">
      <div v-for="p in data.items" :key="p.projectId">
        <p class="text-xs font-medium text-muted mb-1">{{ p.projectName }}</p>
        <ul class="divide-y divide-default">
          <li v-for="g in p.gaps" :key="g.id" class="py-1.5 flex gap-2 min-w-0">
            <NuxtLink
              :to="`/projects/${p.projectId}?tab=gaps`"
              class="text-sm text-highlighted min-w-0 break-words underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >
              {{ g.title }}
            </NuxtLink>
            <span class="ml-auto text-xs text-muted shrink-0">{{ s.gapClass(g.class) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </SectionCard>
</template>
