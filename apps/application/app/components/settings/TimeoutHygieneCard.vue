<script setup lang="ts">
import type { TimeoutThresholds } from '#shared/analytics/timeout-hygiene';

interface TimeoutHygieneSettings {
  thresholds: TimeoutThresholds;
  defaults: TimeoutThresholds;
}

const toast = useToast();
const { data: settings, refresh } = await useFetch<TimeoutHygieneSettings>('/api/settings/timeout-hygiene');

const saving = ref(false);
const values = reactive<Record<keyof TimeoutThresholds, number>>({
  minRuns: 0,
  factor: 0,
  floorMs: 0,
  safety: 0,
  recommendedFloorMs: 0,
  slowStaleP95Ms: 0,
});

watchEffect(() => {
  if (settings.value) Object.assign(values, settings.value.thresholds);
});

const fields: Array<{ key: keyof TimeoutThresholds; label: string; description: string; min: number; step: number }> = [
  {
    key: 'minRuns',
    label: 'Minimum runs',
    description: 'Executions with a duration needed before a test is judged.',
    min: 1,
    step: 1,
  },
  {
    key: 'factor',
    label: 'Oversize factor (×)',
    description: 'Flag a timeout when it is at least this many times the test’s p95 duration.',
    min: 1,
    step: 0.5,
  },
  {
    key: 'floorMs',
    label: 'Minimum headroom (ms)',
    description: 'Only flag when the timeout − p95 gap is at least this many ms.',
    min: 0,
    step: 1000,
  },
  {
    key: 'safety',
    label: 'Recommendation safety (×)',
    description: 'Recommended timeout = p95 × this.',
    min: 1,
    step: 0.5,
  },
  {
    key: 'recommendedFloorMs',
    label: 'Recommendation floor (ms)',
    description: 'Never recommend a timeout below this many ms.',
    min: 0,
    step: 1000,
  },
  {
    key: 'slowStaleP95Ms',
    label: 'Stale slow() p95 (ms)',
    description: 'A test.slow() test is stale when its p95 duration stays under this.',
    min: 0,
    step: 1000,
  },
];

async function save() {
  saving.value = true;
  try {
    const updated = await $fetch<TimeoutHygieneSettings>('/api/settings/timeout-hygiene', {
      method: 'PUT',
      body: { thresholds: { ...values } },
    });
    settings.value = updated;
    toast.add({ title: 'Timeout-hygiene thresholds saved', color: 'success' });
    await refresh();
  } catch (error: unknown) {
    const message =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({ title: 'Save failed', description: message || 'An error occurred', color: 'error' });
  } finally {
    saving.value = false;
  }
}

async function resetToDefaults() {
  saving.value = true;
  try {
    const updated = await $fetch<TimeoutHygieneSettings>('/api/settings/timeout-hygiene', {
      method: 'PUT',
      body: { thresholds: null },
    });
    settings.value = updated;
    Object.assign(values, updated.thresholds);
    toast.add({ title: 'Reset to defaults', color: 'success' });
    await refresh();
  } catch {
    toast.add({ title: 'Reset failed', color: 'error' });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <SectionCard
    icon="i-lucide-scissors"
    title="Timeout hygiene"
    help="settings.timeout-hygiene"
    data-tour="timeout-hygiene-thresholds"
  >
    <template #subtitle>
      Tune how timeout opportunities are detected — oversized per-test timeouts and stale <code>test.slow()</code>
      marks — surfaced per project (Performance tab) and in Analytics. Opportunities are recomputed when viewed, so
      changes apply to existing runs immediately.
    </template>

    <div class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
      <UFormField
        v-for="f in fields"
        :key="f.key"
        :label="f.label"
        :description="f.description"
        :hint="`default ${settings?.defaults[f.key] ?? ''}`"
      >
        <UInput
          v-model.number="values[f.key]"
          type="number"
          :min="f.min"
          :step="f.step"
          :placeholder="`default ${settings?.defaults[f.key] ?? ''}`"
          class="w-full"
        />
      </UFormField>
    </div>

    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <UButton
          variant="ghost"
          color="neutral"
          :disabled="saving"
          label="Reset to defaults"
          @click="resetToDefaults"
        />
        <UButton color="primary" :loading="saving" icon="i-lucide-save" @click="save">Save</UButton>
      </div>
    </template>
  </SectionCard>
</template>
