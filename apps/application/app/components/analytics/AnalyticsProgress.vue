<script setup lang="ts">
import type { AnalyticsProgress } from '#shared/analytics/types';
import { sentencesFor } from '#shared/reports/sentences';

const props = defineProps<{ query: Record<string, string>; title?: string }>();

const {
  data: progress,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsProgress>('progress', () => props.query);

const lines = computed(() => (progress.value ? sentencesFor('en').progress(progress.value, metricFormatter()) : []));
const f = computed(() => metricFormatter());
</script>

<template>
  <SectionCard
    icon="i-lucide-list-checks"
    :title="title ?? 'Fixes and triage'"
    help="analytics.progress"
    data-tour="analytics-progress"
    data-shot="analytics-progress"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load what is being done: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <div v-else-if="progress" class="space-y-3">
      <ul class="space-y-1.5">
        <li v-for="line in lines" :key="line" class="text-sm text-highlighted leading-relaxed">{{ line }}</li>
      </ul>
      <div v-if="progress.recentFixes.length > 0">
        <p class="text-xs font-medium text-muted mb-1">Recent fixes</p>
        <ul class="divide-y divide-default">
          <li v-for="fix in progress.recentFixes" :key="fix.id" class="py-1.5 min-w-0">
            <NuxtLink
              :to="`/failure-clusters/${fix.id}`"
              class="block truncate text-sm text-highlighted underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >
              {{ fix.title }}
            </NuxtLink>
            <p class="text-xs text-muted">
              {{ fix.projectName }} · fixed {{ f.date(fix.fixedAt) }} · {{ fix.held ? 'held' : 'failed again' }}
            </p>
          </li>
        </ul>
      </div>
    </div>
  </SectionCard>
</template>
