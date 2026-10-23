<script setup lang="ts">
import type { SelectionPredicateGroup } from '#shared/selection/types';
import type { AnalyticsScopeSummary } from '#shared/analytics/types';

/**
 * The *Tests* filter of the analytics scope: a selection (resolved in each
 * project by key), test tags, and browsers. With one project in scope, the
 * tags can be saved as a selection the CLI runs with `piwi run <key>`.
 */
const props = defineProps<{
  selection: string;
  tests: SelectionPredicateGroup;
  browsers: string[];
  summary: AnalyticsScopeSummary | null | undefined;
  /** The one project in scope, when there is exactly one. */
  singleProjectId: number | null;
}>();

const emit = defineEmits<{
  'update:selection': [value: string];
  'update:tests': [value: SelectionPredicateGroup];
  'update:browsers': [value: string[]];
}>();

const NONE = '__none__';

const selectionItems = computed(() => [
  { label: 'No selection', value: NONE },
  ...(props.summary?.selections ?? []).map((s) => ({ label: `${s.name} (${s.key})`, value: s.key })),
  // A key from a link that no project in scope knows still shows as picked.
  ...(props.selection && !props.summary?.selections.some((s) => s.key === props.selection)
    ? [{ label: props.selection, value: props.selection }]
    : []),
]);

const selectionModel = computed({
  get: () => props.selection || NONE,
  set: (value: string) => emit('update:selection', value === NONE ? '' : value),
});

const tagsModel = computed({
  get: () => props.tests.tags ?? [],
  set: (value: string[]) => {
    const tags = value.map((t) => t.trim().replace(/^@+/, '')).filter(Boolean);
    const { tags: _old, ...rest } = props.tests;
    emit('update:tests', tags.length > 0 ? { ...rest, tags } : rest);
  },
});

const browsersModel = computed({
  get: () => props.browsers,
  set: (value: string[]) => emit('update:browsers', value),
});

const browserItems = computed(() => [...new Set([...(props.summary?.browsers ?? []), ...props.browsers])].sort());

/** Predicates a link carried beyond tags; shown so they are not invisible. */
const otherPredicates = computed(() =>
  Object.keys(props.tests).filter((key) => key !== 'tags' && props.tests[key as keyof SelectionPredicateGroup] != null),
);

const activeCount = computed(
  () =>
    (props.selection ? 1 : 0) +
    (props.tests.tags?.length ? 1 : 0) +
    otherPredicates.value.length +
    (props.browsers.length ? 1 : 0),
);

function clear() {
  emit('update:selection', '');
  emit('update:tests', {});
  emit('update:browsers', []);
}

// ── Save as selection ────────────────────────────────────────────────────────
const toast = useToast();
const saveKey = ref('');
const saving = ref(false);
const canSave = computed(() => props.singleProjectId !== null && Object.keys(props.tests).length > 0);

async function saveAsSelection() {
  if (!canSave.value || !saveKey.value.trim()) return;
  saving.value = true;
  try {
    const key = saveKey.value.trim().toLowerCase();
    await $fetch(`/api/projects/${props.singleProjectId}/selections`, {
      method: 'POST',
      body: { key, name: key, definition: { include: [props.tests] } },
    });
    toast.add({ title: `Saved as selection "${key}"`, description: `Run it with piwi run ${key}.`, color: 'success' });
    emit('update:selection', key);
    emit('update:tests', {});
    saveKey.value = '';
  } catch (err) {
    toast.add({ title: 'Could not save the selection', description: errorMessage(err), color: 'error' });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UPopover :content="{ align: 'start' }">
    <UButton
      color="neutral"
      variant="outline"
      size="sm"
      icon="i-lucide-filter"
      trailing-icon="i-lucide-chevron-down"
      data-testid="analytics-test-filter"
      data-tour="analytics-tests-button"
    >
      {{ activeCount > 0 ? `Tests (${activeCount})` : 'All tests' }}
    </UButton>

    <template #content>
      <div class="w-[min(22rem,calc(100vw-2rem))] p-3 space-y-3 text-sm" data-tour="analytics-test-filter">
        <div class="flex items-center gap-1">
          <span class="text-xs font-medium text-muted">Tests</span>
          <HelpHint topic="analytics.test-filter" />
        </div>

        <div class="space-y-1">
          <label class="text-xs font-medium text-muted" for="analytics-selection">Selection</label>
          <USelect id="analytics-selection" v-model="selectionModel" :items="selectionItems" size="sm" class="w-full" />
        </div>

        <div class="space-y-1">
          <label class="text-xs font-medium text-muted" for="analytics-test-tags">Test tags (all of them)</label>
          <UInputTags
            id="analytics-test-tags"
            v-model="tagsModel"
            size="sm"
            placeholder="smoke, critical…"
            class="w-full"
          />
        </div>

        <div class="space-y-1">
          <label class="text-xs font-medium text-muted" for="analytics-browsers">Browsers</label>
          <USelectMenu
            id="analytics-browsers"
            v-model="browsersModel"
            :items="browserItems"
            multiple
            size="sm"
            placeholder="Every browser"
            class="w-full"
          />
        </div>

        <p v-if="otherPredicates.length > 0" class="text-xs text-muted">
          The link also filters on {{ otherPredicates.join(', ') }}.
        </p>

        <div v-if="canSave" class="space-y-1 pt-2 border-t border-default">
          <label class="text-xs font-medium text-muted" for="analytics-save-selection">Save as selection</label>
          <div class="flex gap-2">
            <UInput
              id="analytics-save-selection"
              v-model="saveKey"
              size="sm"
              placeholder="key, e.g. smoke"
              class="flex-1 min-w-0"
            />
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :loading="saving"
              :disabled="!saveKey.trim()"
              @click="saveAsSelection"
            >
              Save
            </UButton>
          </div>
        </div>

        <div v-if="activeCount > 0" class="flex justify-end">
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" @click="clear">Clear tests</UButton>
        </div>
      </div>
    </template>
  </UPopover>
</template>
