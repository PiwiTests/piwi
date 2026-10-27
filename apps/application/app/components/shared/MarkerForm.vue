<script setup lang="ts">
import type { FormError } from '@nuxt/ui';
import type { MarkerInfo } from '~~/types/api';
import { MARKER_CATEGORIES, DEFAULT_MARKER_CATEGORY } from '#shared/marker-categories';

/**
 * Create or edit form for one timeline marker, shown in place inside the
 * markers panel. Emits `saved` once the API accepted it, `cancel` to go back
 * to the list, and `delete` when the user asks to delete the edited marker
 * (the panel confirms it).
 */
const props = defineProps<{
  projectId: number;
  /** When set, the form edits this marker; otherwise it creates a new one. */
  marker?: MarkerInfo | null;
  /** Environment values seen in this project's runs, offered as suggestions. */
  environments?: string[];
}>();

const emit = defineEmits<{ saved: [id: number]; cancel: []; delete: [marker: MarkerInfo] }>();

const toast = useToast();

const categoryItems = MARKER_CATEGORIES.map((c) => ({
  label: c.label,
  value: c.id,
  icon: c.icon,
  ui: { icon: `size-5 ${MARKER_TONE_CLASSES[c.color].text}` },
}));

function toLocalInput(value: string | Date): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The panel mounts a fresh form for each marker it opens, so the initial
// values are read once.
const state = reactive({
  label: props.marker?.label ?? '',
  occurredAt: toLocalInput(props.marker?.occurredAt ?? new Date()),
  category: props.marker?.category || DEFAULT_MARKER_CATEGORY,
  environment: props.marker?.environment ?? '',
  description: props.marker?.description ?? '',
});

const isEdit = computed(() => !!props.marker);
const saving = ref(false);
const environmentListId = useId();

function validate(s: typeof state): FormError[] {
  const errors: FormError[] = [];
  if (!s.label.trim()) errors.push({ name: 'label', message: 'Give the marker a label' });
  if (!s.occurredAt) errors.push({ name: 'occurredAt', message: 'Pick when it happened' });
  return errors;
}

async function handleSave() {
  saving.value = true;
  const body = {
    label: state.label.trim(),
    occurredAt: new Date(state.occurredAt).toISOString(),
    category: state.category,
    environment: state.environment.trim() || null,
    description: state.description.trim() || null,
  };

  try {
    const { marker } = props.marker
      ? await $fetch<{ marker: MarkerInfo }>(`/api/markers/${props.marker.id}`, { method: 'PATCH', body })
      : await $fetch<{ marker: MarkerInfo }>(`/api/projects/${props.projectId}/markers`, { method: 'POST', body });
    toast.add({ title: isEdit.value ? 'Marker updated' : 'Marker created', color: 'success' });
    emit('saved', marker.id);
  } catch (error: unknown) {
    toast.add({
      title: isEdit.value ? 'Failed to update marker' : 'Failed to create marker',
      description: errorMessage(error),
      color: 'error',
    });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UForm :state="state" :validate="validate" class="space-y-5" data-testid="marker-form" @submit="handleSave">
    <UFormField label="Label" name="label" required>
      <UInput v-model="state.label" placeholder="e.g. Migrated CI to new runners" autofocus class="w-full" />
    </UFormField>

    <UFormField label="Category" name="category">
      <URadioGroup
        v-model="state.category"
        :items="categoryItems"
        variant="card"
        indicator="hidden"
        size="sm"
        :ui="{ fieldset: 'grid grid-cols-2 sm:grid-cols-3 gap-2', item: 'p-2.5 justify-center' }"
      />
    </UFormField>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <UFormField label="Date & time" name="occurredAt" required>
        <UInput v-model="state.occurredAt" type="datetime-local" class="w-full" />
      </UFormField>

      <UFormField label="Environment" name="environment" hint="Optional">
        <UInput
          v-model="state.environment"
          :list="environmentListId"
          placeholder="All environments"
          icon="i-lucide-server"
          class="w-full"
        />
        <datalist :id="environmentListId">
          <option v-for="env in environments || []" :key="env" :value="env" />
        </datalist>
      </UFormField>
    </div>

    <UFormField label="Description" name="description" hint="Optional">
      <UTextarea
        v-model="state.description"
        :rows="3"
        autoresize
        placeholder="What changed, and why it matters"
        class="w-full"
      />
    </UFormField>

    <div class="flex items-center gap-2 pt-4 border-t border-default">
      <UButton
        v-if="marker"
        label="Delete"
        icon="i-lucide-trash-2"
        color="error"
        variant="ghost"
        @click="emit('delete', marker)"
      />
      <div class="flex gap-2 ms-auto">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="emit('cancel')" />
        <UButton
          type="submit"
          :label="isEdit ? 'Save changes' : 'Add marker'"
          :icon="isEdit ? 'i-lucide-check' : 'i-lucide-plus'"
          :loading="saving"
        />
      </div>
    </div>
  </UForm>
</template>
