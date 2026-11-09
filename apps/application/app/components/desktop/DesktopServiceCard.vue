<script setup lang="ts">
/**
 * Desktop build only: drive the native "Run in background" and "Start on login"
 * options, and the port the bundled server listens on, from the app UI.
 *
 * These are OS/tray-level controls, so the card talks to the Tauri shell over
 * the IPC bridge (window.__TAURI__, injected into the desktop webview). When the
 * bridge is absent — the same URL opened in a normal browser, or an older shell
 * that predates it — it degrades to tray instructions rather than showing dead
 * switches. A shell that predates the port setting reports no port, and the
 * port row stays hidden.
 */
const toast = useToast();

const MIN_PORT = 1024;
const MAX_PORT = 65535;

const loading = ref(true);
const available = ref(false);
const busy = ref(false);
const runInBackground = ref(false);
const startOnLogin = ref(false);
/** The port the server listens on from the next start. */
const serverPort = ref<number | null>(null);
/** The port it listens on now. */
const activePort = ref<number | null>(null);
const portInput = ref<number | undefined>();

const portValid = computed(
  () => Number.isInteger(portInput.value) && portInput.value! >= MIN_PORT && portInput.value! <= MAX_PORT,
);
const portChanged = computed(() => portInput.value !== serverPort.value);
/** Why the shell refused the last port saved (a port browsers refuse). */
const saveRefusal = ref<string | null>(null);
const portError = computed(() => {
  if (portInput.value === undefined || (portInput.value as unknown) === '') return null;
  if (!portValid.value) return `Choose a port between ${MIN_PORT} and ${MAX_PORT}.`;
  return saveRefusal.value;
});
watch(portInput, () => {
  saveRefusal.value = null;
});

async function refresh() {
  const core = tauriCore();
  if (!core) {
    available.value = false;
    loading.value = false;
    return;
  }
  try {
    const s = await core.invoke<{
      run_in_background: boolean;
      start_on_login: boolean;
      server_port?: number;
      active_port?: number;
    }>('desktop_get_service_settings');
    runInBackground.value = !!s.run_in_background;
    startOnLogin.value = !!s.start_on_login;
    serverPort.value = s.server_port ?? null;
    activePort.value = s.active_port ?? null;
    portInput.value = s.server_port;
    available.value = true;
  } catch {
    available.value = false;
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

async function setRunInBackground(value: boolean) {
  const core = tauriCore();
  if (!core) return;
  busy.value = true;
  try {
    await core.invoke('desktop_set_run_in_background', { enabled: value });
    runInBackground.value = value;
  } catch {
    toast.add({ title: 'Could not update "Run in background"', color: 'error' });
  } finally {
    busy.value = false;
  }
}

async function setStartOnLogin(value: boolean) {
  const core = tauriCore();
  if (!core) return;
  busy.value = true;
  try {
    await core.invoke('desktop_set_start_on_login', { enabled: value });
    startOnLogin.value = value;
  } catch {
    toast.add({ title: 'Could not update "Start on login"', color: 'error' });
  } finally {
    busy.value = false;
  }
}

async function savePort() {
  const core = tauriCore();
  if (!core || !portValid.value) return;
  busy.value = true;
  try {
    await core.invoke('desktop_set_server_port', { port: portInput.value });
    serverPort.value = portInput.value!;
  } catch (error) {
    // The shell refuses a port with the reason as its error.
    if (typeof error === 'string') saveRefusal.value = error;
    else toast.add({ title: 'Could not change the server port', color: 'error' });
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
  <SectionCard icon="i-lucide-monitor-cog" title="Desktop app" data-shot="desktop-service">
    <template #subtitle>
      Keep Piwi running in the background, start it automatically when you log in, and choose its port.
    </template>

    <div v-if="loading" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-lucide-loader-2" class="size-4 animate-spin" /> Checking…
    </div>

    <div v-else-if="available" class="space-y-4">
      <div class="flex items-start justify-between gap-4">
        <div class="space-y-0.5">
          <p class="text-sm font-medium">Run in background</p>
          <p class="text-xs text-muted">Closing the window keeps the server running in the tray instead of quitting.</p>
        </div>
        <USwitch :model-value="runInBackground" :disabled="busy" @update:model-value="setRunInBackground" />
      </div>
      <div class="flex items-start justify-between gap-4">
        <div class="space-y-0.5">
          <p class="text-sm font-medium">Start on login</p>
          <p class="text-xs text-muted">
            Launch Piwi automatically (hidden in the tray) when you sign in to your computer.
          </p>
        </div>
        <USwitch :model-value="startOnLogin" :disabled="busy" @update:model-value="setStartOnLogin" />
      </div>
      <div
        v-if="serverPort !== null"
        class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
      >
        <div class="space-y-0.5 min-w-0">
          <p class="text-sm font-medium">Server port</p>
          <p class="text-xs text-muted">
            The port the dashboard listens on, on 127.0.0.1 only. A change reaches the reporter when it finds the app by
            itself, and the AI assistants connected from the MCP page. An address given by hand needs updating, Piwi
            Picker pairing again, and this window's own preferences (local run options, editor, date format) start over.
          </p>
          <p v-if="portError" class="text-xs text-error">{{ portError }}</p>
          <p v-if="activePort !== null && activePort !== serverPort" class="text-xs text-muted">
            Piwi listens on port {{ activePort }} now. It takes port {{ serverPort }} the next time it starts, when that
            port is free.
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <UInput
            v-model.number="portInput"
            type="number"
            :min="MIN_PORT"
            :max="MAX_PORT"
            size="sm"
            class="w-24"
            aria-label="Server port"
            :disabled="busy"
            @keydown.enter="portChanged && savePort()"
          />
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :disabled="busy || !portChanged || !portValid"
            @click="savePort"
          >
            Save
          </UButton>
          <UButton
            v-if="activePort !== null && activePort !== serverPort"
            size="sm"
            color="neutral"
            variant="outline"
            :disabled="busy"
            @click="restart"
          >
            Restart now
          </UButton>
        </div>
      </div>
    </div>

    <div v-else class="space-y-1 text-sm text-muted">
      <p>Manage these from the Piwi tray icon:</p>
      <p class="text-xs">
        Right-click the Piwi icon in your system tray for <strong>Run in background</strong> and
        <strong>Start on login</strong>. On Windows the icon may be hidden under the “show hidden icons” arrow (▲) next
        to the clock — drag it onto the taskbar to keep it in view.
      </p>
    </div>
  </SectionCard>
</template>
