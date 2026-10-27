<script setup lang="ts">
import type { AnalyticsScenarioGaps } from '#shared/analytics/types';
import { sentencesFor } from '#shared/reports/sentences';

const props = defineProps<{ query: Record<string, string>; title?: string }>();

const { data, pending, error, refresh } = await useAnalyticsWidget<AnalyticsScenarioGaps>(
  'scenario-gaps',
  () => props.query,
);

const s = sentencesFor('en');
const openGaps = computed(() => (data.value?.byClass ?? []).reduce((sum, c) => sum + c.count, 0));
</script>

<template>
  <SectionCard
    icon="i-lucide-map"
    :title="title ?? 'Scenario gaps'"
    help="analytics.scenario-gaps"
    data-tour="analytics-scenario-gaps"
    data-shot="analytics-scenario-gaps"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the scenario gaps: ${errorMessage(error)}`">
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
    <div v-else class="space-y-3">
      <StatTileGrid>
        <StatTile label="Open scenario gaps" :value="openGaps" />
        <StatTile label="Gaps closed" :value="data.closed" />
        <StatTile label="Accepted but unwritten" :value="data.acceptedUnwritten" />
        <StatTile label="Open resilience findings" :value="data.findings" />
      </StatTileGrid>
      <div v-if="data.byFeature.length > 0">
        <p class="text-xs font-medium text-muted mb-1">Features with the most open gaps</p>
        <ul class="divide-y divide-default">
          <li v-for="f in data.byFeature" :key="`${f.projectId}:${f.feature}`" class="py-1.5 flex gap-2 min-w-0">
            <NuxtLink
              :to="`/projects/${f.projectId}?tab=gaps`"
              class="text-sm text-highlighted truncate underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >
              {{ f.feature }}
            </NuxtLink>
            <span class="text-xs text-muted truncate">{{ f.projectName }}</span>
            <span class="ml-auto text-xs text-muted shrink-0">
              {{ f.count }} open{{ f.worstClass ? ` · ${s.gapClass(f.worstClass)}` : '' }}
            </span>
          </li>
        </ul>
      </div>
      <p v-if="data.declined > 0" class="text-xs text-muted">
        {{ data.declined }} {{ data.declined === 1 ? 'project declined' : 'projects declined' }} the Test Map and
        {{ data.declined === 1 ? 'is' : 'are' }} left out.
      </p>
    </div>
  </SectionCard>
</template>
