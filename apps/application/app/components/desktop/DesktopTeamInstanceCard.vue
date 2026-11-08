<script setup lang="ts">
/**
 * Desktop build only: **Run on my machine**, the app taking run requests from one team instance. Connect starts the
 * device flow there: the person allows the app on the instance's page, and the shell keeps the key it gives in the OS
 * keychain. While connected, the folders linked to the instance's projects are listed here; a request for a project
 * with none asks for its folder in its confirmation. Disconnecting removes the key from the keychain; it stays listed
 * in the instance's Connected apps until it is revoked there.
 */
import type { RunTargetConnectionView } from '@piwitests/editor/run-target-view';

const { connection } = useDesktopTeamRequests();
const toast = useToast();
const instanceUrl = ref('');
const busy = ref(false);
const folders = ref<Record<string, string>>({});

const { data: initial } = useFetch<{ connection: RunTargetConnectionView }>('/api/desktop/run-target', {
  server: false,
  default: () => ({ connection: connection.value }),
});
watch(
  () => initial.value?.connection,
  (value) => {
    if (value) connection.value = value;
  },
  { immediate: true },
);

const STATE_WORDS: Record<RunTargetConnectionView['state'], string> = {
  none: 'Not connected',
  'signing-in': 'Waiting for you to allow this app on the instance',
  connecting: 'Connecting',
  online: 'Connected: requests from your pages come here',
  offline: 'Connected, the instance does not answer: trying again',
  revoked: 'Disconnected by the instance',
};

const connected = computed(() => ['connecting', 'online', 'offline'].includes(connection.value.state));

async function loadFolders() {
  const core = tauriCore();
  if (!core || !connected.value) {
    folders.value = {};
    return;
  }
  folders.value = (await core.invoke<Record<string, string> | null>('desktop_request_folders').catch(() => null)) ?? {};
}
watch(() => [connection.value.state, connection.value.linkedProjectIds.join(',')], loadFolders, { immediate: true });

async function connect() {
  if (!instanceUrl.value.trim() || busy.value) return;
  busy.value = true;
  try {
    connection.value = await $fetch<RunTargetConnectionView>('/api/desktop/run-target/connect', {
      method: 'POST',
      body: { instance: instanceUrl.value.trim() },
    });
    if (connection.value.verificationUrl) openPage(connection.value.verificationUrl);
  } catch (error) {
    toast.add({ title: 'Could not connect', description: errorMessage(error), color: 'error' });
  } finally {
    busy.value = false;
  }
}

function openPage(url: string) {
  tauriCore()
    ?.invoke('desktop_open_external', { url })
    .catch(() => {});
}

async function disconnect() {
  const core = tauriCore();
  if (!core || busy.value) return;
  busy.value = true;
  try {
    await core.invoke('desktop_forget_run_target');
  } catch (error) {
    toast.add({ title: 'Could not disconnect', description: errorMessage(error), color: 'error' });
  } finally {
    busy.value = false;
  }
}

async function unlink(projectId: string) {
  await tauriCore()
    ?.invoke('desktop_unlink_request_folder', { projectId })
    .catch((error: unknown) =>
      toast.add({ title: 'Could not unlink', description: errorMessage(error), color: 'error' }),
    );
  await loadFolders();
}
</script>

<template>
  <SectionCard icon="i-lucide-monitor-play" title="Run on my machine" data-shot="desktop-team-instance-card">
    <template #subtitle>
      Take run requests from your team instance: a test you open there runs here, in a browser on your screen.
    </template>

    <div class="space-y-4 text-sm">
      <p class="text-muted">
        Each request shows in this window first, with its tests, the checks of your folder and the command: nothing runs
        until you click <strong>Run</strong>. The run reports to the instance, and only you see it there.
      </p>

      <div class="space-y-1">
        <div class="text-muted">Status</div>
        <div class="text-highlighted">{{ STATE_WORDS[connection.state] }}</div>
        <code v-if="connection.instance && connection.state !== 'none'" class="text-xs break-all">{{
          connection.instance
        }}</code>
        <p v-if="connection.error" class="text-xs text-error">{{ connection.error }}</p>
      </div>

      <div v-if="connection.state === 'signing-in'" class="space-y-2">
        <p class="text-muted">
          The instance's page asks you to allow <strong>Piwi Desktop</strong> with this code:
          <code class="text-highlighted">{{ connection.userCode }}</code>
        </p>
        <div class="flex flex-wrap gap-2">
          <UButton
            v-if="connection.verificationUrl"
            color="neutral"
            variant="outline"
            @click="openPage(connection.verificationUrl)"
            >Open the page again</UButton
          >
          <UButton color="neutral" variant="ghost" :loading="busy" @click="disconnect">Cancel</UButton>
        </div>
      </div>

      <form v-else-if="!connected" method="post" class="flex flex-col sm:flex-row gap-2" @submit.prevent="connect">
        <UInput
          v-model="instanceUrl"
          type="url"
          placeholder="https://piwi.example.com"
          class="flex-1"
          aria-label="Team instance address"
        />
        <UButton type="submit" :loading="busy" :disabled="!instanceUrl.trim()">Connect</UButton>
      </form>

      <template v-else>
        <div class="space-y-1">
          <div class="text-muted">Linked folders</div>
          <p v-if="Object.keys(folders).length === 0" class="text-xs text-muted">
            None yet: a request for a project asks for its folder.
          </p>
          <ul v-else class="space-y-1">
            <li v-for="(folder, projectId) in folders" :key="projectId" class="flex items-start gap-2 min-w-0">
              <span class="text-xs text-muted shrink-0">Project {{ projectId }}</span>
              <code class="text-xs break-all flex-1">{{ folder }}</code>
              <UButton color="neutral" variant="ghost" size="xs" @click="unlink(String(projectId))">Unlink</UButton>
            </li>
          </ul>
        </div>
        <UButton color="neutral" variant="outline" :loading="busy" @click="disconnect">Disconnect</UButton>
      </template>
    </div>
  </SectionCard>
</template>
