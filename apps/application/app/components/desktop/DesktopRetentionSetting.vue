<script setup lang="ts">
/**
 * Desktop build only: how many days of runs the bundled server's nightly sweep keeps
 * (`PIWI_RETENTION_DAYS`). The shell stores the choice and hands it to the server when it starts,
 * so a change applies at the next start, with **Restart now** meanwhile. Shown in the Storage
 * page's cleanup card; renders nothing without the native bridge, or with a shell that predates
 * the setting.
 */
const toast = useToast();

const PERIODS = [30, 60, 90, 180, 365];

const available = ref(false);
const busy = ref(false);
/** The days kept from the next start: `null` until chosen, when the server follows its environment. */
const configured = ref<number | null>(null);
/** The days the running server keeps: the choice it started with, else `PIWI_RETENTION_DAYS` from its environment. */
const active = ref<number | null>(null);

const selected = computed(() => configured.value ?? active.value ?? 0);
const options = computed(() => {
  const days = new Set([...PERIODS, ...(selected.value > 0 ? [selected.value] : [])]);
  return [
    { label: 'Never', value: 0 },
    ...[...days]
      .sort((a, b) => a - b)
      .map((n) => ({ label: n === 365 ? 'After 1 year' : `After ${n} days`, value: n })),
  ];
});
const pendingRestart = computed(() => configured.value !== null && configured.value !== (active.value ?? 0));

onMounted(async () => {
  const core = tauriCore();
  if (!core) return;
  try {
    const settings = await core.invoke<{ retention_days?: number | null; active_retention_days?: number | null }>(
      'desktop_get_service_settings',
    );
    if (!('retention_days' in settings)) return;
    configured.value = settings.retention_days ?? null;
    active.value = settings.active_retention_days ?? null;
    available.value = true;
  } catch {
    available.value = false;
  }
});

async function save(days: number) {
  const core = tauriCore();
  if (!core) return;
  busy.value = true;
  try {
    await core.invoke('desktop_set_retention_days', { days });
    configured.value = days;
  } catch {
    toast.add({ title: 'Could not change the automatic cleanup', color: 'error' });
  } finally {
    busy.value = false;
  }
}

async function restart() {
  // The shell asks first when local test runs would stop, then relaunches.
  await tauriCore()
    ?.invoke('desktop_restart_app')
    .catch(() => toast.add({ title: 'Could not restart Piwi', color: 'error' }));
}
</script>

<template>
  <div
    v-if="available"
    class="mb-4 flex flex-col gap-3 border-b border-default pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
    data-shot="desktop-retention"
  >
    <div class="min-w-0 space-y-0.5">
      <p class="text-sm font-medium">Delete old runs automatically</p>
      <p class="text-xs text-muted">
        A few minutes after Piwi starts and each night while it runs, runs older than this are deleted with their files,
        except the ones kept forever.
      </p>
      <p v-if="pendingRestart" class="text-xs text-muted">Piwi applies the change the next time it starts.</p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <USelect
        :model-value="selected"
        :items="options"
        :disabled="busy"
        size="sm"
        class="w-36"
        aria-label="Delete old runs automatically"
        @update:model-value="(days: number) => save(days)"
      />
      <UButton v-if="pendingRestart" size="sm" color="neutral" variant="outline" :disabled="busy" @click="restart">
        Restart now
      </UButton>
    </div>
  </div>
</template>
