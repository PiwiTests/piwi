<script setup lang="ts">
/**
 * The values a project keeps for one tracker screen's fields — its issue type's
 * create screen, or a workflow transition's screen: the required fields, then
 * each optional field a value is set for (removable), a menu
 * to set one for another field, and a note for each value whose field this
 * screen does not have (kept, but not sent).
 */
import {
  hasFieldValue,
  MANAGED_FIELDS,
  requiredFieldsToAsk,
  settableFields,
  type FieldValues,
  type TrackerField,
} from '#shared/integrations/fields';

const props = withDefaults(
  defineProps<{
    fields: TrackerField[];
    connectionId?: number | null;
    projectKey?: string | null;
    /** Fields never asked for here; by default the ones Piwi fills on a create. */
    skipped?: ReadonlySet<string>;
    /** How the off-screen note names the screen, e.g. "this transition's screen". */
    screenLabel?: string;
  }>(),
  { skipped: () => MANAGED_FIELDS, screenLabel: "this issue type's screen" },
);

const values = defineModel<FieldValues>({ required: true });

/** The required fields to give a value: required and not skipped. */
const required = computed(() => requiredFieldsToAsk(props.fields, props.skipped));
/** Optional fields a value is set for, on this screen. */
const optionalWithValue = computed(() =>
  settableFields(props.fields, props.skipped).filter(
    (f) => !required.value.includes(f) && hasFieldValue(values.value[f.id]?.value),
  ),
);
/** Fields added through the menu, shown with an empty input until a value is chosen. */
const added = ref<TrackerField[]>([]);
const shownOptional = computed(() => [
  ...optionalWithValue.value,
  ...added.value.filter((f) => !optionalWithValue.value.includes(f)),
]);
/** Optional fields that could take a value, for the "Set a default for another field" menu. */
const addable = computed(() =>
  settableFields(props.fields, props.skipped).filter(
    (f) => !required.value.includes(f) && !added.value.includes(f) && !hasFieldValue(values.value[f.id]?.value),
  ),
);
/** Values for fields this screen does not have: kept, but not sent. */
const offScreen = computed(() => {
  if (!props.fields.length) return [];
  const onScreen = new Set(props.fields.map((f) => f.id));
  return Object.entries(values.value).filter(([id]) => !onScreen.has(id));
});

watch(
  () => props.fields,
  () => (added.value = []),
);

function remove(id: string) {
  const next = { ...values.value };
  delete next[id];
  values.value = next;
}
</script>

<template>
  <div class="space-y-3">
    <TrackerFieldsList
      v-if="required.length"
      v-model="values"
      :fields="required"
      :connection-id="connectionId"
      :project-key="projectKey"
    />
    <TrackerFieldsList
      v-if="shownOptional.length"
      v-model="values"
      :fields="shownOptional"
      :connection-id="connectionId"
      :project-key="projectKey"
      removable
    />
    <TrackerFieldPicker
      v-if="addable.length"
      :fields="addable"
      label="Set a default for another field"
      @pick="(f) => added.push(f)"
    />
    <p v-for="[id, entry] in offScreen" :key="id" class="text-xs text-muted">
      {{ id }} = {{ entry.label }} is not on {{ screenLabel }}, so it is not sent.
      <button type="button" :class="SENTENCE_LINK_CLASS" @click="remove(id)">Remove it</button>
    </p>
  </div>
</template>
