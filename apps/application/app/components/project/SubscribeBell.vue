<script setup lang="ts">
import type { NotificationEvent, SubscriptionFilters } from '#shared/notification-events';
import {
  NOTIFICATION_EVENTS,
  describeSubscriptionFilters,
  notificationEventLabel as eventLabel,
} from '#shared/notification-events';

const props = defineProps<{
  projectId: number;
  projectLabel?: string;
  /** Branch names the project's runs reported, offered by the branch filter. */
  knownBranches?: string[];
  /** Environment names the project's runs reported, offered by the environment filter. */
  knownEnvironments?: string[];
}>();

const config = useRuntimeConfig();
const isDemoMode = config.public.demoMode;
const authEnabled = computed(() => config.public.authEnabled);
const { authState, canSeeAdmin } = useAuth();
const isAuthenticated = computed(() => authState.value.authenticated);

const toast = useToast();
const open = ref(false);

const demoNotifications = isDemoMode ? useDemoNotifications() : null;

const cookie = !authEnabled.value && !isDemoMode ? useBrowserNotificationCookie() : null;

// ── Cookie-based (no auth) ───────────────────────────────────────────────────
const permission = ref<NotificationPermission>('default');
const supported = computed(() => import.meta.client && 'Notification' in window);

if (import.meta.client && 'Notification' in window) {
  permission.value = Notification.permission;
}

const cookieEvents = computed(() => cookie?.getProject(props.projectId).events ?? []);

const cookieSubscribed = computed(() => cookie?.isSubscribed(props.projectId) ?? false);

async function requestPermission() {
  if (!supported.value || permission.value !== 'default') return;
  permission.value = await Notification.requestPermission();
}

function isCookieEventSelected(evt: NotificationEvent): boolean {
  return cookieEvents.value.includes(evt);
}

function toggleCookieEvent(evt: NotificationEvent) {
  cookie?.toggleEvent(props.projectId, evt);
}

// ── Channel subscriptions ────────────────────────────────────────────────────
interface Subscription {
  id: number;
  userId?: number | null;
  events: string[];
  filters: SubscriptionFilters | null;
  mode: string;
  mutedUntil: string | null;
  active: boolean;
  channel: { id: number; name: string; type: string };
}

/** `filters` with its branch and environment lists replaced; null when nothing is left to filter on. */
function withRunScope(
  filters: SubscriptionFilters | null,
  branches: string[],
  environments: string[],
): SubscriptionFilters | null {
  const { branches: _branches, environments: _environments, ...rest } = filters ?? {};
  const next: SubscriptionFilters = {
    ...rest,
    ...(branches.length ? { branches } : {}),
    ...(environments.length ? { environments } : {}),
  };
  return Object.keys(next).length ? next : null;
}

// Channels/subscriptions are reachable in demo mode, without auth (instance-wide
// rows via the virtual admin), and for signed-in users when auth is on. They load
// in the browser, after the page shows: the bell's icon is all the page renders
// from them until its menu opens.
const shouldFetch = isDemoMode || !authEnabled.value || isAuthenticated.value;
const fetchOpts = { server: false, lazy: true } as const;

const { data: subsData, refresh: refreshSubs } = await useFetch<{ items: Subscription[] }>(
  `/api/subscriptions?projectId=${props.projectId}`,
  { immediate: shouldFetch, ...fetchOpts },
);

const subs = computed(() => subsData.value?.items ?? []);
const isSubscribed = computed(() => subs.value.length > 0);

// ── Channels ─────────────────────────────────────────────────────────────────
interface Channel {
  id: number;
  name: string;
  type: string;
  userId?: number | null;
  config?: Record<string, unknown>;
}

const { data: channelsData } = await useFetch<{ items: Channel[] }>('/api/channels', {
  immediate: shouldFetch,
  ...fetchOpts,
});

const channels = computed(() => channelsData.value?.items ?? []);

// ── New subscription form ─────────────────────────────────────────────────────
const showForm = ref(false);
const selectedChannelId = ref<number | undefined>(undefined);
const selectedEvents = ref<string[]>(['run.failed', 'environment.incident']);
const selectedBranches = ref<string[]>([]);
const selectedEnvironments = ref<string[]>([]);
const subscribeGlobal = ref(false);
const subscribing = ref(false);

const selectedChannel = computed(() => channels.value.find((c) => c.id === selectedChannelId.value));
// Global subscriptions require a global channel (the API enforces the same).
const canSubscribeGlobal = computed(
  () => authEnabled.value && canSeeAdmin.value && selectedChannel.value?.userId === null,
);

/** Whether the viewer can edit/mute/remove this subscription (mirrors the API rules). */
function canManageSub(sub: Subscription) {
  return sub.userId === null ? canSeeAdmin.value : true;
}

// ── Edit subscription ─────────────────────────────────────────────────────────
const editingSub = ref<Subscription | null>(null);
const editChannelId = ref<number | undefined>(undefined);
const editEvents = ref<string[]>([]);
const editBranches = ref<string[]>([]);
const editEnvironments = ref<string[]>([]);
const savingEdit = ref(false);

function startEdit(sub: Subscription) {
  editingSub.value = sub;
  editChannelId.value = sub.channel.id;
  editEvents.value = [...sub.events];
  editBranches.value = [...(sub.filters?.branches ?? [])];
  editEnvironments.value = [...(sub.filters?.environments ?? [])];
}

function cancelEdit() {
  editingSub.value = null;
}

async function saveEdit() {
  if (!editingSub.value || !editChannelId.value || editEvents.value.length === 0) return;
  savingEdit.value = true;
  try {
    await $fetch(`/api/subscriptions/${editingSub.value.id}`, {
      method: 'PATCH',
      body: {
        channelId: editChannelId.value,
        events: editEvents.value as NotificationEvent[],
        filters: withRunScope(editingSub.value.filters, editBranches.value, editEnvironments.value),
      },
    });
    await refreshSubs();
    editingSub.value = null;
  } catch (e) {
    toast.add({ title: 'Update failed', description: String((e as Error)?.message ?? e), color: 'error' });
  } finally {
    savingEdit.value = false;
  }
}

const channelItems = computed(() =>
  channels.value.map((c) => ({
    label: c.type === 'personal_email' ? `${c.name} (${(c.config as Record<string, unknown>).address})` : c.name,
    value: c.id,
  })),
);

const eventItems = NOTIFICATION_EVENTS.map((e) => ({
  label: eventLabel(e),
  value: e,
}));

watch(open, (val) => {
  if (val) {
    if (shouldFetch) refreshSubs();
    if (channels.value.length > 0 && !selectedChannelId.value) {
      selectedChannelId.value = channels.value[0]!.id;
    }
  } else {
    showForm.value = false;
    editingSub.value = null;
  }
});

watch(showForm, (shown) => {
  if (shown) return;
  selectedBranches.value = [];
  selectedEnvironments.value = [];
  subscribeGlobal.value = false;
});

async function subscribe() {
  if (!selectedChannelId.value || selectedEvents.value.length === 0) return;
  subscribing.value = true;
  try {
    const filters = withRunScope(null, selectedBranches.value, selectedEnvironments.value);
    await $fetch('/api/subscriptions', {
      method: 'POST',
      body: {
        channelId: selectedChannelId.value,
        projectId: props.projectId,
        events: selectedEvents.value,
        ...(filters ? { filters } : {}),
        mode: 'realtime',
        ...(canSubscribeGlobal.value && subscribeGlobal.value ? { global: true } : {}),
      },
    });
    await refreshSubs();
    showForm.value = false;
    toast.add({ title: 'Subscribed', color: 'success' });
    if (isDemoMode) {
      demoNotifications?.scheduleFor(props.projectId, props.projectLabel || 'this project', selectedEvents.value);
    }
  } catch (e) {
    toast.add({ title: 'Subscribe failed', description: String((e as Error)?.message ?? e), color: 'error' });
  } finally {
    subscribing.value = false;
  }
}

async function unsubscribe(id: number) {
  try {
    await $fetch(`/api/subscriptions/${id}`, { method: 'DELETE' });
    await refreshSubs();
    toast.add({ title: 'Unsubscribed', color: 'success' });
    if (isDemoMode && subs.value.length === 0) {
      demoNotifications?.cancelFor(props.projectId);
    }
  } catch (e) {
    toast.add({ title: 'Failed', description: String((e as Error)?.message ?? e), color: 'error' });
  }
}

async function toggleMute(sub: Subscription) {
  const muted = sub.mutedUntil && new Date(sub.mutedUntil) > new Date();
  try {
    await $fetch(`/api/subscriptions/${sub.id}`, {
      method: 'PATCH',
      body: { mutedUntil: muted ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
    });
    await refreshSubs();
  } catch (e) {
    toast.add({ title: 'Failed', description: String((e as Error)?.message ?? e), color: 'error' });
  }
}

function isMuted(sub: Subscription) {
  return sub.mutedUntil && new Date(sub.mutedUntil) > new Date();
}

function filterSummary(sub: Subscription) {
  return describeSubscriptionFilters(sub.filters).join(' · ');
}

function channelIcon(type: string) {
  if (type === 'personal_email') return 'i-lucide-user-round';
  if (type === 'email') return 'i-lucide-mail';
  if (type === 'slack') return 'i-lucide-slack';
  return 'i-lucide-webhook';
}

const showComponent = computed(() => isDemoMode || (authEnabled.value && isAuthenticated.value) || cookie != null);
const bellSubscribed = computed(() =>
  isDemoMode || authEnabled.value ? isSubscribed.value : cookieSubscribed.value || isSubscribed.value,
);
</script>

<template>
  <UPopover v-if="showComponent" v-model:open="open" :ui="{ content: 'w-80' }">
    <UButton
      :icon="bellSubscribed ? 'i-lucide-bell-ring' : 'i-lucide-bell'"
      size="sm"
      :color="bellSubscribed ? 'primary' : 'neutral'"
      :variant="bellSubscribed ? 'soft' : 'outline'"
      title="Notification subscriptions for this project"
      data-tour="subscribe-bell"
    />

    <template #content>
      <!-- Cookie-based UI (no auth) -->
      <div v-if="cookie" class="p-3 space-y-3">
        <div class="flex items-center justify-between">
          <span class="font-medium text-sm">Browser notifications</span>
        </div>

        <p v-if="supported && permission === 'default'" class="text-xs text-gray-500">
          <UButton variant="link" size="xs" class="p-0" @click="requestPermission"> Allow notifications </UButton>
          {{ ' ' }}in your browser to get alerts for this project.
        </p>

        <p v-else-if="supported && permission === 'denied'" class="text-xs text-gray-500">
          Notifications are blocked. Check your browser settings to allow them.
        </p>

        <p v-else-if="!supported" class="text-xs text-gray-500">Notifications are not supported in this browser.</p>

        <template v-if="supported && permission === 'granted'">
          <USeparator />
          <div class="space-y-1">
            <label
              v-for="item in eventItems"
              :key="item.value"
              class="flex items-center gap-1.5 text-xs cursor-pointer"
            >
              <input
                type="checkbox"
                :checked="isCookieEventSelected(item.value as NotificationEvent)"
                class="accent-primary size-3"
                @change="toggleCookieEvent(item.value as NotificationEvent)"
              />
              {{ item.label }}
            </label>
          </div>
        </template>
      </div>

      <!-- Channel subscriptions -->
      <div
        v-if="shouldFetch"
        class="p-3 space-y-3"
        :class="cookie ? 'border-t border-default' : ''"
        data-tour="project-subscriptions"
      >
        <div class="flex items-center justify-between">
          <span class="font-medium text-sm inline-flex items-center gap-1">
            {{ cookie ? 'Channel subscriptions' : 'Notifications' }} <HelpHint topic="notifications.subscribe" />
          </span>
          <UButton
            v-if="!showForm"
            size="xs"
            icon="i-lucide-plus"
            variant="ghost"
            color="neutral"
            :disabled="channels.length === 0"
            @click="showForm = true"
          >
            Add
          </UButton>
        </div>

        <!-- Demo hint -->
        <div v-if="isDemoMode" class="text-xs text-muted bg-primary/5 rounded px-2 py-1.5">
          <UIcon name="i-lucide-sparkles" class="size-3 inline-block mr-1 text-primary" />
          Demo — notifications will appear as toasts in ~8 s.
        </div>

        <!-- No channels hint (non-demo only) -->
        <div v-else-if="channels.length === 0" class="text-xs text-muted text-center py-2">
          No channels configured.<br />
          <NuxtLink to="/settings/notifications" class="text-primary underline">Add one in Settings</NuxtLink>
        </div>

        <!-- Existing subscriptions -->
        <div v-if="subs.length > 0" class="space-y-1.5">
          <template v-for="sub in subs" :key="sub.id">
            <!-- Inline edit form -->
            <div
              v-if="editingSub?.id === sub.id"
              class="space-y-2 rounded border border-primary/30 bg-primary/5 px-2 py-2"
            >
              <UFormField label="Channel" size="xs">
                <USelect
                  v-model="editChannelId"
                  :items="channelItems"
                  value-key="value"
                  class="w-full text-xs"
                  size="xs"
                />
              </UFormField>
              <UFormField label="Events" size="xs">
                <div class="space-y-1">
                  <label
                    v-for="item in eventItems"
                    :key="item.value"
                    class="flex items-center gap-1.5 text-xs cursor-pointer"
                  >
                    <input type="checkbox" :value="item.value" v-model="editEvents" class="accent-primary size-3" />
                    {{ item.label }}
                  </label>
                </div>
              </UFormField>
              <SubscriptionScopeFields
                v-model:branches="editBranches"
                v-model:environments="editEnvironments"
                :known-branches="knownBranches"
                :known-environments="knownEnvironments"
              />
              <div class="flex gap-1.5 justify-end">
                <UButton size="xs" color="neutral" variant="ghost" @click="cancelEdit">Cancel</UButton>
                <UButton
                  size="xs"
                  color="primary"
                  :loading="savingEdit"
                  :disabled="!editChannelId || editEvents.length === 0"
                  @click="saveEdit"
                >
                  Save
                </UButton>
              </div>
            </div>

            <!-- Normal row -->
            <div
              v-else
              class="flex items-center gap-2 rounded px-2 py-1.5 text-xs"
              :class="isMuted(sub) ? 'opacity-60' : ''"
            >
              <UIcon :name="channelIcon(sub.channel.type)" class="size-3.5 text-muted shrink-0" />
              <span class="flex-1 min-w-0">
                <span class="block font-medium truncate">
                  {{ sub.channel.name }}
                  <span v-if="sub.userId === null && authEnabled" class="text-primary">(global)</span>
                </span>
                <span
                  v-if="filterSummary(sub)"
                  class="block text-muted truncate"
                  :title="filterSummary(sub)"
                  data-testid="subscription-filters"
                >
                  {{ filterSummary(sub) }}
                </span>
              </span>
              <template v-if="canManageSub(sub)">
                <UButton
                  icon="i-lucide-pencil"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  title="Edit subscription"
                  @click="startEdit(sub)"
                />
                <UButton
                  :icon="isMuted(sub) ? 'i-lucide-bell' : 'i-lucide-bell-off'"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :title="isMuted(sub) ? 'Unmute' : 'Mute 7 days'"
                  @click="toggleMute(sub)"
                />
                <UButton
                  icon="i-lucide-x"
                  color="error"
                  variant="ghost"
                  size="xs"
                  title="Unsubscribe"
                  @click="unsubscribe(sub.id)"
                />
              </template>
            </div>
          </template>
        </div>

        <div v-else-if="!showForm && channels.length > 0" class="text-xs text-muted text-center py-1">
          Not subscribed to this project.
        </div>

        <!-- Subscribe form -->
        <div v-if="showForm" class="space-y-2 border-t border-default pt-2">
          <UFormField label="Channel" size="xs">
            <USelect
              v-model="selectedChannelId"
              :items="channelItems"
              value-key="value"
              class="w-full text-xs"
              size="xs"
            />
          </UFormField>
          <UFormField label="Events" size="xs">
            <div class="space-y-1">
              <label
                v-for="item in eventItems"
                :key="item.value"
                class="flex items-center gap-1.5 text-xs cursor-pointer"
              >
                <input type="checkbox" :value="item.value" v-model="selectedEvents" class="accent-primary size-3" />
                {{ item.label }}
              </label>
            </div>
          </UFormField>
          <SubscriptionScopeFields
            v-model:branches="selectedBranches"
            v-model:environments="selectedEnvironments"
            :known-branches="knownBranches"
            :known-environments="knownEnvironments"
          />
          <label
            v-if="canSubscribeGlobal"
            class="flex items-center gap-1.5 text-xs cursor-pointer"
            title="Deliver to this channel for everyone, not tied to your account"
          >
            <input type="checkbox" v-model="subscribeGlobal" class="accent-primary size-3" />
            Instance-wide (global)
          </label>
          <div class="flex gap-1.5 justify-end">
            <UButton size="xs" color="neutral" variant="ghost" @click="showForm = false">Cancel</UButton>
            <UButton
              size="xs"
              color="primary"
              :loading="subscribing"
              :disabled="!selectedChannelId || selectedEvents.length === 0"
              @click="subscribe"
            >
              Subscribe
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
