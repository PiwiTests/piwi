<script setup lang="ts">
import { pageEnvVars, getSettingsPage } from '~/utils/settings-metadata';

interface WastedSettings {
  patterns: string[];
  envManaged: boolean;
  isDefault: boolean;
  defaults: string[];
}

const toast = useToast();

const { data: settings, refresh } = await useFetch<WastedSettings>('/api/settings/wasted-waits');

// Edited as free text, one pattern per line.
const text = ref('');
const saving = ref(false);

watchEffect(() => {
  if (settings.value) text.value = settings.value.patterns.join('\n');
});

const envManaged = computed(() => settings.value?.envManaged ?? false);
const envVars = pageEnvVars(getSettingsPage('performance'));

function parseText(value: string): string[] {
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function save() {
  saving.value = true;
  try {
    const updated = await $fetch<WastedSettings>('/api/settings/wasted-waits', {
      method: 'PUT',
      body: { patterns: parseText(text.value) },
    });
    settings.value = updated;
    toast.add({ title: 'Wasted-time patterns saved', color: 'success' });
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
    const updated = await $fetch<WastedSettings>('/api/settings/wasted-waits', {
      method: 'PUT',
      body: { patterns: null },
    });
    settings.value = updated;
    text.value = updated.patterns.join('\n');
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
  <div class="space-y-6">
    <EnvManagedAlert v-if="envManaged" :env-vars="envVars" />

    <SectionCard
      icon="i-lucide-hourglass"
      title="Wasted-time patterns"
      help="settings.wasted-time"
      data-tour="wasted-time-patterns"
    >
      <template #subtitle>
        Define which wait steps count as <strong>wasted time</strong>. A wait is wasted when any pattern below matches
        its step title or its source location. Patterns are case-insensitive and support <code>*</code> and
        <code>?</code> wildcards. Wasted time is recomputed when runs are viewed, so changes apply to existing runs
        immediately.
      </template>

      <div class="space-y-4">
        <SettingsField
          label="Patterns"
          help="settings.wasted-time"
          :env-managed="envManaged"
          description="One glob pattern per line. An empty list means no wait is counted as wasted."
        >
          <UTextarea
            v-model="text"
            :rows="6"
            :disabled="envManaged"
            class="w-full font-mono"
            placeholder="Wait for timeout*&#10;*waitForTimeout*"
          />
        </SettingsField>

        <p class="text-xs text-gray-400">
          Default:
          <code>{{ settings?.defaults.join(', ') }}</code>
          — counts explicit <code>waitForTimeout</code> sleeps only. Use <code>*</code> to count every wait.
        </p>
      </div>

      <template #footer>
        <div class="flex items-center gap-2 justify-end">
          <UButton
            variant="ghost"
            color="neutral"
            :disabled="saving || envManaged"
            label="Reset to defaults"
            @click="resetToDefaults"
          />
          <UButton color="primary" :loading="saving" :disabled="envManaged" icon="i-lucide-save" @click="save">
            Save
          </UButton>
        </div>
      </template>
    </SectionCard>
  </div>
</template>
