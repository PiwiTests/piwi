<script setup lang="ts">
/**
 * Whether closing the window leaves Piwi Runner in the tray, and whether it starts on login: the tray menu's two
 * toggles, here too for a desktop that shows no tray icon. Reads and writes them through the shell, which keeps the
 * tray's checks in step and sends `piwi:background-settings` when either side changes them.
 */
interface BackgroundSettings {
  run_in_background: boolean;
  start_on_login: boolean;
}

const toast = useToast();
const settings = ref<BackgroundSettings | null>(null);
const saving = ref(false);

let unlisten: (() => void) | null = null;

onMounted(async () => {
  const core = tauriCore();
  if (!core) return;
  unlisten =
    (await tauriEvent()?.listen<BackgroundSettings>('piwi:background-settings', ({ payload }) => {
      settings.value = payload;
    })) ?? null;
  try {
    settings.value = await core.invoke<BackgroundSettings>('desktop_get_service_settings');
  } catch {
    // Leaves the card hidden: the tray menu holds the same toggles.
  }
});

onScopeDispose(() => unlisten?.());

async function save(command: string, field: keyof BackgroundSettings, enabled: boolean) {
  const core = tauriCore();
  if (!core || !settings.value) return;
  saving.value = true;
  try {
    await core.invoke(command, { enabled });
    settings.value[field] = enabled;
  } catch (error) {
    toast.add({
      title: 'Could not save the setting',
      description: error instanceof Error ? error.message : String(error),
      color: 'error',
    });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UCard v-if="settings" data-testid="runner-background">
    <template #header>
      <h2 class="text-sm font-semibold">In the background</h2>
    </template>
    <div class="space-y-3">
      <UCheckbox
        :model-value="settings.run_in_background"
        :disabled="saving"
        label="Keep running in the tray when the window closes"
        description="The instance reaches this machine only while Piwi Runner runs. Turned off, closing the window quits it."
        @update:model-value="save('desktop_set_run_in_background', 'run_in_background', $event === true)"
      />
      <UCheckbox
        :model-value="settings.start_on_login"
        :disabled="saving"
        label="Start on login"
        description="Starts Piwi Runner in the tray when you sign in."
        @update:model-value="save('desktop_set_start_on_login', 'start_on_login', $event === true)"
      />
    </div>
  </UCard>
</template>
