<script setup lang="ts">
/**
 * Every locator chain the project's tests use, the chains shared by the most
 * tests first, with a text filter, a stability filter and, when runs recorded
 * the page of each call, a page filter. Each row opens "Who uses this?". A
 * brittle or watched chain says why, from the locator stability rules.
 */
import type { LocatorIndex } from '#shared/locator-index';
import { assessLocator, stabilityLabels } from '#shared/locator-stability';
import { foldText } from '#shared/utils/fold-text';
import type { LocatorStabilityFilter } from '~/utils/locator-stability';
import { ALL_PAGES, formatPageList } from '~/utils/locator-pages';

const props = defineProps<{ index: LocatorIndex }>();
const emit = defineEmits<{ inspect: [locator: string] }>();
const stability = defineModel<LocatorStabilityFilter>('stability', { default: 'all' });
/** A page key; `ALL_PAGES` for every page. */
const page = defineModel<string>('page', { default: ALL_PAGES });

const PAGE = 50;
const search = useViewState('locators:search', () => '');
const shown = useViewState('locators:shown', () => PAGE);
watch([search, stability, page], () => (shown.value = PAGE));

const assessed = computed(() =>
  props.index.locators.map((entry) => {
    const positions = new Set(entry.uses.flatMap((u) => u.pages ?? []));
    const pages = [...positions].sort((a, b) => a - b).map((i) => props.index.pages?.[i] ?? '');
    return { entry, stability: assessLocator(entry.locator), pages };
  }),
);

const pageItems = computed(() => [
  { label: 'All pages', value: ALL_PAGES },
  ...(props.index.pages ?? []).map((p) => ({ label: p, value: p })),
]);

const counts = computed(() => {
  let brittle = 0;
  let watchCount = 0;
  for (const { stability: s } of assessed.value) {
    if (s?.level === 'brittle') brittle++;
    else if (s?.level === 'watch') watchCount++;
  }
  return { brittle, watch: watchCount };
});

const stabilityItems = computed(() => [
  { label: 'All locators', value: 'all' },
  { label: `Brittle (${counts.value.brittle})`, value: 'brittle' },
  { label: `Watch (${counts.value.watch})`, value: 'watch' },
]);

const rows = computed(() => {
  const q = foldText(search.value.trim());
  return assessed.value
    .filter(({ entry, stability: s, pages }) => {
      if (stability.value !== 'all' && s?.level !== stability.value) return false;
      if (page.value !== ALL_PAGES && !pages.includes(page.value)) return false;
      return !q || foldText(entry.locator).includes(q);
    })
    .map(({ entry, stability: s, pages }) => ({
      entry,
      tests: new Set(entry.uses.map((u) => u.test)).size,
      actions: [...new Set(entry.uses.flatMap((u) => u.actions))],
      stability: s && s.level !== 'stable' ? `${s.level}: ${stabilityLabels(s, ', ')}` : null,
      stabilityDetail: s?.findings.map((f) => f.detail).join('\n') ?? '',
      pages: pages.length ? formatPageList(pages) : null,
      pagesDetail: pages.join('\n'),
    }));
});
</script>

<template>
  <div class="space-y-3" data-shot="locator-list">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <UInput
        v-model="search"
        icon="i-lucide-search"
        placeholder="Filter locators"
        aria-label="Filter locators"
        class="w-full sm:max-w-sm"
      />
      <USelect v-model="stability" :items="stabilityItems" size="md" class="w-full sm:w-44" aria-label="Stability" />
      <USelect
        v-if="index.pages?.length"
        v-model="page"
        :items="pageItems"
        size="md"
        class="w-full sm:w-52"
        aria-label="Page"
      />
    </div>
    <EmptyState v-if="rows.length === 0" icon="i-lucide-crosshair" text="No locator matches the filter." />
    <ul v-else class="divide-y divide-default border-y border-default">
      <li
        v-for="row in rows.slice(0, shown)"
        :key="row.entry.locator"
        class="py-2.5 flex flex-col gap-2 sm:flex-row sm:items-start"
      >
        <div class="min-w-0 flex-1 space-y-1">
          <LocatorCode :locator="row.entry.locator" class="text-sm" />
          <p class="text-xs text-muted">
            {{ row.actions.slice(0, 4).map(locatorActionLabel).join(', ')
            }}<template v-if="row.actions.length > 4"> and {{ row.actions.length - 4 }} more</template> · last seen
            {{ formatRelativeTime(row.entry.lastSeenAt)
            }}<template v-if="row.pages">
              · on <span data-pages :title="row.pagesDetail">{{ row.pages }}</span></template
            ><template v-if="row.stability">
              · <span data-stability :title="row.stabilityDetail">{{ row.stability }}</span></template
            >
          </p>
        </div>
        <UButton
          color="neutral"
          variant="outline"
          size="xs"
          class="self-start shrink-0"
          :title="`Who uses ${row.entry.locator}?`"
          @click="emit('inspect', row.entry.locator)"
        >
          <span class="tabular-nums">{{ row.tests }}</span>
          {{ row.tests === 1 ? 'test' : 'tests' }}
        </UButton>
      </li>
    </ul>
    <div v-if="rows.length > shown" class="flex items-center gap-3">
      <UButton color="neutral" variant="outline" size="sm" @click="shown += PAGE">Show more</UButton>
      <span class="text-xs text-muted">{{ rows.length - shown }} more</span>
    </div>
    <p v-if="index.truncated" class="text-xs text-muted">
      The project has more locators than the list carries; the least used are left out.
    </p>
  </div>
</template>
