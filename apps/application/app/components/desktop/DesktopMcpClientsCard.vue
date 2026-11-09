<script setup lang="ts">
/**
 * Desktop shell only: one-click MCP client configuration. The shell detects
 * installed clients (Claude Code, Claude Desktop, Cursor, VS Code, Windsurf,
 * Gemini CLI, Opencode), writes the `piwi-desktop` entry into their own config
 * files, and keeps written entries current across launches. Renders nothing
 * without the IPC bridge, so the /mcp page can mount it unconditionally.
 */
interface McpClientStatus {
  id: string;
  label: string;
  config_path: string;
  status: 'not_installed' | 'not_connected' | 'connected' | 'stale' | 'manual';
  detail: string | null;
}

const toast = useToast();

const available = ref(false);
const loading = ref(true);
const clients = ref<McpClientStatus[]>([]);
const busyId = ref<string | null>(null);

async function refresh() {
  const core = tauriCore();
  if (!core) return;
  try {
    clients.value = await core.invoke<McpClientStatus[]>('desktop_mcp_clients');
    available.value = true;
  } catch {
    available.value = false;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (tauriCore()) void refresh();
  else loading.value = false;
});

async function setConnected(client: McpClientStatus, connect: boolean) {
  const core = tauriCore();
  if (!core) return;
  busyId.value = client.id;
  try {
    const updated = await core.invoke<McpClientStatus>(connect ? 'desktop_mcp_connect' : 'desktop_mcp_disconnect', {
      clientId: client.id,
    });
    clients.value = clients.value.map((c) => (c.id === updated.id ? updated : c));
    toast.add({
      title: connect ? `${client.label} connected` : `${client.label} disconnected`,
      description: connect ? `Restart ${client.label} to pick up the new server.` : undefined,
      color: 'success',
      icon: 'i-lucide-plug',
    });
  } catch (error) {
    toast.add({ title: `Could not update ${client.label}`, description: errorMessage(error), color: 'error' });
  } finally {
    busyId.value = null;
  }
}

async function reveal(client: McpClientStatus) {
  const core = tauriCore();
  if (!core) return;
  try {
    await core.invoke('desktop_mcp_reveal', { clientId: client.id });
  } catch (error) {
    toast.add({ title: 'Could not open the file', description: errorMessage(error), color: 'error' });
  }
}

function badgeOf(client: McpClientStatus): { label: string; color: 'success' | 'warning' | 'neutral' } | null {
  switch (client.status) {
    case 'connected':
      return { label: 'Connected', color: 'success' };
    case 'stale':
      return { label: 'Needs update', color: 'warning' };
    case 'manual':
      return { label: 'Manual setup', color: 'warning' };
    case 'not_installed':
      return { label: 'Not detected', color: 'neutral' };
    default:
      return null;
  }
}
</script>

<template>
  <SectionCard v-if="available" icon="i-lucide-plug-zap" title="Connect a client on this machine">
    <template #subtitle>
      One click writes the <code>piwi-desktop</code> entry into the client's own config file (the first backup is kept
      next to it) and keeps that entry pointing at this app when the app moves. Restart the client after connecting.
    </template>

    <div v-if="loading" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-lucide-loader-2" class="size-4 animate-spin" /> Detecting clients…
    </div>

    <div v-else class="space-y-2">
      <div
        v-for="client in clients"
        :key="client.id"
        :data-testid="`mcp-client-${client.id}`"
        class="flex items-center gap-3 rounded-md border border-default p-2.5"
        :class="client.status === 'not_installed' ? 'opacity-60' : ''"
      >
        <UIcon name="i-lucide-bot" class="size-4 text-gray-400 shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <p class="text-sm font-medium">{{ client.label }}</p>
            <UBadge v-if="badgeOf(client)" :color="badgeOf(client)!.color" variant="subtle" size="sm">
              {{ badgeOf(client)!.label }}
            </UBadge>
          </div>
          <p v-if="client.config_path" class="text-xs text-muted truncate">{{ client.config_path }}</p>
          <p v-if="client.detail" class="text-xs text-warning">{{ client.detail }}</p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <UButton
            v-if="client.status === 'not_connected'"
            size="xs"
            icon="i-lucide-plug"
            :loading="busyId === client.id"
            @click="setConnected(client, true)"
          >
            Connect
          </UButton>
          <UButton
            v-else-if="client.status === 'stale'"
            size="xs"
            color="warning"
            icon="i-lucide-refresh-cw"
            :loading="busyId === client.id"
            @click="setConnected(client, true)"
          >
            Update
          </UButton>
          <UButton
            v-if="client.status === 'connected' || client.status === 'stale'"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-unplug"
            :loading="busyId === client.id"
            @click="setConnected(client, false)"
          >
            Disconnect
          </UButton>
          <UButton
            v-if="client.status !== 'not_installed' && client.config_path"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-folder-open"
            aria-label="Reveal config file"
            title="Reveal config file"
            @click="reveal(client)"
          />
        </div>
      </div>

      <p class="text-xs text-muted">
        A client that is not listed — or marked manual — can always be connected with the snippets below.
      </p>
    </div>
  </SectionCard>
</template>
