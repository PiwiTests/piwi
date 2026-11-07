<script setup lang="ts">
import type { ConnectedApp, ConnectedAppsResponse } from '~~/types/api';

/**
 * The apps a user connected through the device flow (Piwi Picker, an editor, the desktop app, Piwi Runner), each with
 * when it last connected and, for an app that runs tests, whether it is online now; **Revoke** disconnects one. Keyed
 * by `userId`, as `ApiKeysManager` is, so it serves the Account page and the administrator's Users page alike.
 */
const props = defineProps<{ userId: number }>();

const toast = useToast();

const KIND_ICONS: Record<ConnectedApp['kind'], string> = {
  picker: 'i-lucide-mouse-pointer-click',
  editor: 'i-lucide-code',
  desktop: 'i-lucide-monitor',
  runner: 'i-lucide-server',
};

const apps = ref<ConnectedApp[]>([]);

async function loadApps() {
  try {
    apps.value = (await $fetch<ConnectedAppsResponse>(`/api/users/${props.userId}/connected-apps`)).items;
  } catch {
    apps.value = [];
  }
}

watch(() => props.userId, loadApps, { immediate: true });

const isRevokeOpen = ref(false);
const appToRevoke = ref<ConnectedApp | null>(null);

function confirmRevoke(app: ConnectedApp) {
  appToRevoke.value = app;
  isRevokeOpen.value = true;
}

async function revoke() {
  const app = appToRevoke.value;
  if (!app) return;
  // appToRevoke stays set: the closing modal still renders its text.
  isRevokeOpen.value = false;
  try {
    await $fetch(`/api/users/${props.userId}/api-keys/${app.id}`, { method: 'DELETE' });
    toast.add({ title: 'App disconnected', description: `"${app.name}" has to connect again`, color: 'success' });
    await loadApps();
  } catch (error: unknown) {
    const message =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({ title: 'Failed to disconnect the app', description: message || 'An error occurred', color: 'error' });
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-sm text-muted">
      The apps connected to this instance from their own window: Piwi Picker, an editor, the desktop app, Piwi Runner.
      Each holds a key of its own; revoke one to disconnect it.
    </p>

    <div v-if="apps.length > 0" class="space-y-2" data-shot="connected-apps">
      <div
        v-for="app in apps"
        :key="app.id"
        class="flex items-center justify-between gap-3 rounded-lg border border-default px-4 py-3"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-start gap-2">
            <UIcon :name="KIND_ICONS[app.kind] ?? 'i-lucide-plug'" class="text-muted shrink-0 mt-1" />
            <span class="font-medium min-w-0 break-words">{{ app.name }}</span>
          </div>
          <div class="text-xs text-muted mt-1 flex flex-wrap gap-x-4">
            <span>Connected: <ClientDate :date="app.createdAt" date-only /></span>
            <span v-if="app.target?.online">Online now</span>
            <ClientOnly v-else-if="app.target?.lastSeenAt">
              <span :title="prettyDateFormat(app.target.lastSeenAt)"
                >Last seen {{ formatRelativeTime(app.target.lastSeenAt) }}</span
              >
            </ClientOnly>
            <span v-else-if="!app.target && app.lastUsedAt"
              >Last used: <ClientDate :date="app.lastUsedAt" date-only
            /></span>
            <span v-if="app.target?.version">Version {{ app.target.version }}</span>
          </div>
        </div>
        <UButton
          label="Revoke"
          icon="i-lucide-unplug"
          color="error"
          variant="ghost"
          size="sm"
          @click="confirmRevoke(app)"
        />
      </div>
    </div>

    <div v-else class="text-center text-muted py-6 text-sm">
      No connected apps. Connect Piwi Picker, an editor, the desktop app or Piwi Runner from its own window.
    </div>

    <ClientOnly>
      <UModal :open="isRevokeOpen" title="Disconnect app" @update:open="isRevokeOpen = $event">
        <template #body>
          <p>
            Disconnect <strong>"{{ appToRevoke?.name }}"</strong>? It loses access at once and has to connect again.
          </p>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" label="Cancel" @click="isRevokeOpen = false" />
          <UButton color="error" label="Revoke" icon="i-lucide-unplug" @click="revoke" />
        </template>
      </UModal>
    </ClientOnly>
  </div>
</template>
