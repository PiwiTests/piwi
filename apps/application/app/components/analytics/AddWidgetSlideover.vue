<script setup lang="ts">
/**
 * *Add widget* in the dashboard editor: every widget of the registry, grouped
 * by the band it belongs to, with a search. The Test Map widgets are left out
 * where the Test Map is declined.
 */
import { ANALYTICS_BANDS, ANALYTICS_WIDGETS, type AnalyticsWidgetId } from '#shared/analytics/registry';
import { foldText } from '#shared/utils/fold-text';

defineProps<{ bandTitle: string }>();
const emit = defineEmits<{ add: [type: AnalyticsWidgetId]; closed: [] }>();
const open = defineModel<boolean>('open', { default: false });

const { isHidden } = await useInstanceCapabilities();
const search = ref('');

const groups = computed(() => {
  const q = foldText(search.value.trim());
  return ANALYTICS_BANDS.map((band) => ({
    label: band.label,
    widgets: ANALYTICS_WIDGETS.filter(
      (w) =>
        w.band === band.id &&
        (!('capability' in w) || !isHidden(w.capability)) &&
        (!q || foldText(w.title).includes(q) || foldText(w.description).includes(q)),
    ),
  })).filter((g) => g.widgets.length > 0);
});

function pick(type: AnalyticsWidgetId) {
  emit('add', type);
  open.value = false;
}

watch(open, (isOpen) => {
  if (isOpen) search.value = '';
});
</script>

<template>
  <USlideover v-model:open="open" :title="`Add a widget to ${bandTitle}`" @after:leave="emit('closed')">
    <template #body>
      <div class="space-y-4" data-testid="add-widget">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          placeholder="Search widgets"
          class="w-full"
          aria-label="Search widgets"
        />
        <p v-if="groups.length === 0" class="text-sm text-muted">No widget matches.</p>
        <section v-for="group in groups" :key="group.label" class="space-y-1">
          <h3 class="text-xs font-medium text-muted">{{ group.label }}</h3>
          <ul class="divide-y divide-default">
            <li v-for="w in group.widgets" :key="w.id">
              <button
                type="button"
                class="w-full text-left py-2 px-1 rounded hover:bg-elevated"
                :data-testid="`add-widget-${w.id}`"
                @click="pick(w.id)"
              >
                <span class="block text-sm text-highlighted">{{ w.title }}</span>
                <span class="block text-xs text-muted">
                  {{ w.description }}<template v-if="'requires' in w"> One project only.</template>
                </span>
              </button>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </USlideover>
</template>
