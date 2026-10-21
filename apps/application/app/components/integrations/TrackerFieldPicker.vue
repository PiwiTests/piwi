<script setup lang="ts">
/**
 * A searchable menu of tracker fields to add on demand: picking one emits it and
 * the menu clears, so the next field can be picked. A screen can list a hundred
 * custom fields, hence a search rather than a plain dropdown.
 */
import type { TrackerField } from '#shared/integrations/fields';

const props = defineProps<{
  fields: TrackerField[];
  /** The menu's prompt, e.g. "Add a field". */
  label: string;
}>();

const emit = defineEmits<{ pick: [field: TrackerField] }>();

/** Two fields sharing a name (two "Team" fields) are told apart by their id. */
const items = computed(() => {
  const counts = new Map<string, number>();
  for (const f of props.fields) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
  return props.fields.map((f) => ({
    label: (counts.get(f.name) ?? 0) > 1 ? `${f.name} (${f.id})` : f.name,
    value: f.id,
  }));
});

const chosen = ref<string | undefined>(undefined);

function pick(id: string | undefined) {
  const field = props.fields.find((f) => f.id === id);
  if (field) emit('pick', field);
  void nextTick(() => (chosen.value = undefined));
}
</script>

<template>
  <USelectMenu
    v-model="chosen"
    :items="items"
    value-key="value"
    :placeholder="label"
    :search-input="{ placeholder: 'Search fields…' }"
    icon="i-lucide-plus"
    color="neutral"
    variant="outline"
    size="sm"
    class="w-full sm:w-64"
    data-testid="tracker-field-picker"
    @update:model-value="pick"
  />
</template>
