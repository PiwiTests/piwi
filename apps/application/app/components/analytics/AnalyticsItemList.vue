<script setup lang="ts">
import type { AnalyticsList } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const { data, pending, error, refresh } = await useAnalyticsWidget<AnalyticsList>(
  'list',
  () => props.query,
  () => props.options,
);

const SOURCE_TITLES: Record<AnalyticsList['source'], string> = {
  runs: 'Latest runs',
  'failure-clusters': 'Open failure causes',
  'flaky-tests': 'Flakiest tests',
  'scenario-gaps': 'Open scenario gaps',
};
const cardTitle = computed(
  () => props.title ?? SOURCE_TITLES[(props.options?.source as AnalyticsList['source']) ?? 'runs'],
);
</script>

<template>
  <SectionCard
    icon="i-lucide-list"
    :title="cardTitle"
    help="analytics.list"
    data-tour="analytics-list"
    data-shot="analytics-list"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the list: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!data || data.items.length === 0" text="Nothing matches this scope." />
    <ul v-else class="divide-y divide-default">
      <li v-for="item in data.items" :key="item.id" class="py-2 min-w-0">
        <NuxtLink
          :to="item.href"
          class="text-sm text-highlighted break-words underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          {{ item.title }}
        </NuxtLink>
        <p class="text-xs text-muted break-words">
          {{ item.projectName }}<template v-if="item.detail"> · {{ item.detail }}</template>
          <ClientOnly v-if="item.at"> · {{ formatRelativeTime(item.at) }}</ClientOnly>
        </p>
      </li>
    </ul>
    <p v-if="data && data.declined > 0" class="text-xs text-muted mt-2">
      {{ data.declined }} {{ data.declined === 1 ? 'project declined' : 'projects declined' }} the Test Map and
      {{ data.declined === 1 ? 'is' : 'are' }} left out.
    </p>
  </SectionCard>
</template>
