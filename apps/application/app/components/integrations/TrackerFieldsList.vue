<script setup lang="ts">
/**
 * A grid of tracker fields, each labelled with its Jira name (marked when
 * required) and edited through {@link TrackerFieldInput}. Short values sit two
 * to a row; a value that reads long takes the full row, after the short ones.
 * Edits the field values as one map; a removable list adds a clear button per
 * row, for the optional defaults a project chose to set or the fields a create
 * added on demand.
 */
import type { FieldValue, FieldValues, TrackerField, TrackerFieldKind } from '#shared/integrations/fields';

const props = defineProps<{
  fields: TrackerField[];
  connectionId?: number | null;
  projectKey?: string | null;
  /** Show a remove button per row. */
  removable?: boolean;
}>();

const values = defineModel<FieldValues>({ required: true });

const emit = defineEmits<{
  /** A row's remove button was clicked, after its value was cleared. */
  remove: [id: string];
}>();

/** Kinds whose value reads long: an issue and its summary, rich text, several values. */
const FULL_ROW_KINDS: ReadonlySet<TrackerFieldKind> = new Set([
  'issue',
  'issue-key',
  'text',
  'option-array',
  'user-array',
  'string-array',
  'group-array',
]);
const fullRow = (field: TrackerField) => FULL_ROW_KINDS.has(field.kind);
const ordered = computed(() => [...props.fields.filter((f) => !fullRow(f)), ...props.fields.filter(fullRow)]);

function update(id: string, value: FieldValue | null | undefined) {
  const next = { ...values.value };
  if (value) next[id] = value;
  else delete next[id];
  values.value = next;
}
</script>

<template>
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <UFormField
      v-for="field in ordered"
      :key="field.id"
      :class="fullRow(field) ? 'sm:col-span-2' : undefined"
      :label="field.name"
      :required="field.required"
      :hint="field.kind === 'raw' ? field.typeName : undefined"
      :data-field-id="field.id"
    >
      <div class="flex items-center gap-1">
        <TrackerFieldInput
          :field="field"
          :model-value="values[field.id]"
          :connection-id="connectionId"
          :project-key="projectKey"
          class="min-w-0 flex-1"
          @update:model-value="(value) => update(field.id, value)"
        />
        <UButton
          v-if="removable"
          type="button"
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="xs"
          :title="`Stop setting ${field.name}`"
          :aria-label="`Stop setting ${field.name}`"
          @click="
            update(field.id, null);
            emit('remove', field.id);
          "
        />
      </div>
    </UFormField>
  </div>
</template>
