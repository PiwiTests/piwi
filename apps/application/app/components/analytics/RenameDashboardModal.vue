<script setup lang="ts">
/**
 * Rename a saved dashboard and edit its description. Saves over the version the
 * reader opened: when someone saved it since, nothing is written and the reader
 * is asked to reload. Opened from *Rename…* on the dashboard and on the
 * dashboards list.
 */
import { DASHBOARD_LIMITS } from '#shared/analytics/dashboards';
import type { DashboardView } from '#shared/handlers/dashboards';

const props = defineProps<{
  dashboard: { id: string; name: string; description: string | null; updatedAt: string | null } | null;
}>();
const emit = defineEmits<{ saved: [view: DashboardView] }>();
const open = defineModel<boolean>('open', { default: false });

const toast = useToast();
const name = ref('');
const description = ref('');
const saving = ref(false);

watch(open, (isOpen) => {
  if (!isOpen || !props.dashboard) return;
  name.value = props.dashboard.name;
  description.value = props.dashboard.description ?? '';
});

const valid = computed(() => name.value.trim().length > 0);

async function save() {
  const d = props.dashboard;
  if (!d || !valid.value || !d.updatedAt) return;
  saving.value = true;
  try {
    const saved = await $fetch<DashboardView>(`/api/dashboards/${d.id}`, {
      method: 'PATCH',
      body: { name: name.value.trim(), description: description.value.trim() || null, updatedAt: d.updatedAt },
    });
    open.value = false;
    emit('saved', saved);
    toast.add({ title: 'Dashboard renamed', color: 'success' });
  } catch (error: any) {
    const conflict = error?.statusCode === 409 || error?.response?.status === 409;
    toast.add({
      title: "Couldn't rename the dashboard",
      description: conflict
        ? 'Someone saved it since you opened it. Reload the page and rename it again.'
        : errorMessage(error),
      color: 'error',
    });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Rename dashboard">
    <template #body>
      <form class="space-y-4" data-testid="rename-dashboard" method="post" @submit.prevent="save">
        <UFormField label="Name" required>
          <UInput
            v-model="name"
            class="w-full"
            :maxlength="DASHBOARD_LIMITS.name"
            autofocus
            data-testid="rename-dashboard-name"
          />
        </UFormField>
        <UFormField label="Description">
          <UTextarea
            v-model="description"
            class="w-full"
            :rows="2"
            autoresize
            :maxlength="DASHBOARD_LIMITS.description"
            placeholder="What this dashboard is for (optional)"
            data-testid="rename-dashboard-description"
          />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton
          color="primary"
          label="Save"
          :loading="saving"
          :disabled="!valid"
          data-testid="rename-dashboard-save"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
