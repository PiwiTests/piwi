<script setup lang="ts">
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';
import {
  describeSubscriptionFilters,
  notificationEventLabel,
  type SubscriptionFilters,
} from '#shared/notification-events';

const toast = useToast();
const config = useRuntimeConfig();
const authEnabled = computed(() => config.public.authEnabled);
const { canSeeAdmin } = useAuth();

// SMTP env vars (read-only display) — from the shared registry via the help topic.
const smtpEnvVars: PiwiEnvVarName[] = [
  'PIWI_SMTP_HOST',
  'PIWI_SMTP_PORT',
  'PIWI_SMTP_USER',
  'PIWI_SMTP_PASS',
  'PIWI_SMTP_FROM',
  'PIWI_SMTP_FROM_NAME',
  'PIWI_SMTP_SECURE',
];

// ── SMTP status ────────────────────────────────────────────────────────────────
interface SmtpStatus {
  host: string | null;
  port: number | null;
  user: string | null;
  from: string | null;
  fromName: string | null;
  hasPassword: boolean;
  secure: boolean;
  configured: boolean;
  envManaged: boolean;
}

const { data: smtp } = await useFetch<SmtpStatus>('/api/settings/smtp');
const testEmailTo = ref('');
const testingSmtp = ref(false);

async function sendTestEmail() {
  if (!testEmailTo.value) return;
  testingSmtp.value = true;
  try {
    const res = await $fetch<{ success: boolean; error?: string }>('/api/settings/smtp/test', {
      method: 'POST',
      body: { to: testEmailTo.value },
    });
    if (res.success) {
      toast.add({ title: 'Test email sent', description: `Check ${testEmailTo.value}`, color: 'success' });
    } else {
      toast.add({ title: 'Send failed', description: res.error || 'Unknown error', color: 'error' });
    }
  } catch (e) {
    toast.add({ title: 'Send failed', description: String((e as Error)?.message ?? e), color: 'error' });
  } finally {
    testingSmtp.value = false;
  }
}

// ── Channels ──────────────────────────────────────────────────────────────────
interface Channel {
  id: number;
  name: string;
  type: string;
  userId: number | null;
  verified: boolean;
  config: Record<string, unknown>;
}

const { data: channelsData, refresh: refreshChannels } = await useFetch<{
  items: Channel[];
  canStoreSecrets?: boolean;
}>('/api/channels');

const channels = computed(() => channelsData.value?.items ?? []);

const showNewChannel = ref(false);
const testingChannel = ref<number | null>(null);

async function onChannelSaved() {
  showNewChannel.value = false;
  await refreshChannels();
}

async function deleteChannel(id: number) {
  try {
    await $fetch(`/api/channels/${id}`, { method: 'DELETE' });
    await refreshChannels();
    toast.add({ title: 'Channel deleted', color: 'success' });
  } catch (e) {
    toast.add({ title: 'Failed to delete channel', description: String((e as Error)?.message ?? e), color: 'error' });
  }
}

async function testChannel(id: number) {
  testingChannel.value = id;
  try {
    const res = await $fetch<{ success: boolean; error?: string; hint?: string }>(`/api/channels/${id}/test`, {
      method: 'POST',
    });
    if (res.success) {
      toast.add({ title: 'Test notification sent', color: 'success' });
      await refreshChannels();
    } else {
      toast.add({ title: 'Test failed', description: [res.error, res.hint].filter(Boolean).join(' '), color: 'error' });
    }
  } catch (e) {
    toast.add({ title: 'Test failed', description: String((e as Error)?.message ?? e), color: 'error' });
  } finally {
    testingChannel.value = null;
  }
}

/** Whether the viewer can delete/test this channel (mirrors the API rules). */
function canManageChannel(ch: Channel) {
  return ch.userId !== null || canSeeAdmin.value;
}

// ── Subscriptions ─────────────────────────────────────────────────────────────
interface Subscription {
  id: number;
  userId: number | null;
  projectId: number | null;
  events: string[] | null;
  filters: SubscriptionFilters | null;
  mode: string;
  digestAt: string | null;
  mutedUntil: string | null;
  active: boolean;
  channel: { id: number; name: string; type: string };
}

const { data: subsData, refresh: refreshSubs } = await useFetch<{ items: Subscription[] }>('/api/subscriptions');

const subs = computed(() => subsData.value?.items ?? []);

/** Whether the viewer can edit/delete this subscription (mirrors the API rules). */
function canManageSub(sub: Subscription) {
  return sub.userId !== null || canSeeAdmin.value;
}

async function deleteSub(id: number) {
  try {
    await $fetch(`/api/subscriptions/${id}`, { method: 'DELETE' });
    await refreshSubs();
    toast.add({ title: 'Subscription removed', color: 'success' });
  } catch (e) {
    toast.add({
      title: 'Failed to remove subscription',
      description: String((e as Error)?.message ?? e),
      color: 'error',
    });
  }
}

async function toggleMute(sub: Subscription) {
  const isMuted = sub.mutedUntil && new Date(sub.mutedUntil) > new Date();
  try {
    await $fetch(`/api/subscriptions/${sub.id}`, {
      method: 'PATCH',
      body: { mutedUntil: isMuted ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
    });
    await refreshSubs();
    toast.add({ title: isMuted ? 'Unmuted' : 'Muted for 7 days', color: 'success' });
  } catch (e) {
    toast.add({
      title: 'Failed to update subscription',
      description: String((e as Error)?.message ?? e),
      color: 'error',
    });
  }
}

function isMuted(sub: Subscription) {
  return sub.mutedUntil && new Date(sub.mutedUntil) > new Date();
}

function channelTypeIcon(type: string) {
  if (type === 'personal_email') return 'i-lucide-user-round';
  if (type === 'email') return 'i-lucide-mail';
  if (type === 'slack') return 'i-lucide-slack';
  if (type === 'teams') return 'i-lucide-messages-square';
  if (type === 'browser') return 'i-lucide-monitor';
  return 'i-lucide-webhook';
}

/** Why an unverified channel shows its badge, and what verifies it. */
function unverifiedChannelHint(type: string): string {
  if (type === 'personal_email') return 'Verify your account email in Account settings to receive email here';
  if (type === 'email') return 'No successful test yet: email is sent here once a test arrives';
  return 'No successful test yet: send one to verify delivery';
}

const eventLabel = notificationEventLabel;
</script>

<template>
  <CapabilityDeclinedGuard capability="notifications" label="Notifications">
    <div class="space-y-6" data-tour="notifications-page">
      <!-- SMTP status (read-only; connection details are admin-only) -->
      <SectionCard
        icon="i-lucide-mail"
        title="SMTP email delivery"
        help="settings.smtp"
        data-tour="smtp-email-delivery"
      >
        <template #subtitle>
          Configure SMTP via environment variables. The connection cannot be changed here.
        </template>
        <template #actions>
          <EnvManagedBadge v-if="smtp?.configured && canSeeAdmin" :env-vars="smtpEnvVars" size="md" />
        </template>

        <div class="space-y-3">
          <div v-if="smtp?.configured" class="flex items-center gap-2 text-sm text-success-600 dark:text-success-400">
            <UIcon name="i-lucide-circle-check-big" class="size-4" />
            Configured
          </div>
          <div v-else class="flex items-center gap-2 text-sm text-warning-600 dark:text-warning-400">
            <UIcon name="i-lucide-circle-alert" class="size-4" />
            Not configured
          </div>

          <div v-if="smtp?.host" class="grid grid-cols-2 gap-2 text-sm">
            <div class="text-muted">Host</div>
            <div class="font-mono">{{ smtp?.host }}:{{ smtp?.port }}</div>
            <div class="text-muted">From</div>
            <div>{{ smtp?.fromName ? `${smtp.fromName} <${smtp.from}>` : smtp?.from }}</div>
            <div class="text-muted">User</div>
            <div class="font-mono">{{ smtp?.user || '— (no authentication)' }}</div>
            <div class="text-muted">TLS</div>
            <div>{{ smtp?.secure ? 'Yes (port 465)' : 'STARTTLS / plain' }}</div>
          </div>

          <div v-if="!smtp?.configured && canSeeAdmin" class="text-sm text-muted space-y-1">
            <p>
              Set these environment variables to enable email notifications — the user and password are only needed when
              the server requires authentication:
            </p>
            <CodeBlock
              code="PIWI_SMTP_HOST=smtp.example.com
PIWI_SMTP_PORT=465
PIWI_SMTP_FROM=noreply@example.com
PIWI_SMTP_FROM_NAME=Piwi Dashboard
PIWI_SMTP_USER=user@example.com
PIWI_SMTP_PASS=secret"
              lang="bash"
            />
          </div>
          <p v-else-if="!smtp?.configured" class="text-sm text-muted">
            Email delivery is not set up, so email channels will not send. An administrator can configure it via
            environment variables.
          </p>
        </div>

        <template v-if="smtp?.configured && canSeeAdmin" #footer>
          <div class="flex items-center gap-2 w-full">
            <HelpHint topic="notifications.test-email" />
            <UInput v-model="testEmailTo" type="email" placeholder="Send test to email address…" class="flex-1" />
            <UButton
              color="neutral"
              variant="soft"
              icon="i-lucide-send"
              :loading="testingSmtp"
              :disabled="!testEmailTo"
              @click="sendTestEmail"
            >
              Send test
            </UButton>
          </div>
        </template>
      </SectionCard>

      <!-- Channels -->
      <SectionCard
        icon="i-lucide-radio"
        title="Notification channels"
        :count="channels.length"
        help="notifications.channels"
        data-tour="notification-channels"
      >
        <template #actions>
          <UButton
            size="sm"
            icon="i-lucide-plus"
            data-tour="add-notification-channel"
            @click="showNewChannel = !showNewChannel"
          >
            Add channel
          </UButton>
        </template>

        <NotificationChannelForm
          v-if="showNewChannel"
          :auth-enabled="!!authEnabled"
          :can-see-admin="canSeeAdmin"
          :smtp-configured="!!smtp?.configured"
          :can-store-secrets="channelsData?.canStoreSecrets ?? true"
          @saved="onChannelSaved"
          @cancel="showNewChannel = false"
        />

        <div v-if="channels.length === 0 && !showNewChannel" class="text-sm text-muted py-4 text-center">
          No channels yet. Add one to start receiving notifications.
        </div>

        <div class="space-y-2">
          <div
            v-for="ch in channels"
            :key="ch.id"
            class="flex items-center gap-3 rounded-lg border border-default px-4 py-3"
          >
            <UIcon :name="channelTypeIcon(ch.type)" class="size-5 text-muted shrink-0" />
            <div class="flex-1 min-w-0">
              <div class="font-medium text-sm flex items-center gap-1.5">
                {{ ch.name }}
                <UBadge v-if="ch.type === 'personal_email'" size="xs" variant="soft" color="neutral">auto</UBadge>
                <UTooltip v-if="ch.type !== 'browser' && !ch.verified" :text="unverifiedChannelHint(ch.type)">
                  <UBadge size="xs" variant="soft" color="warning">unverified</UBadge>
                </UTooltip>
              </div>
              <div class="text-xs text-muted">
                <template v-if="ch.type === 'personal_email' || ch.type === 'email'">{{
                  ch.config.address as string
                }}</template>
                <template v-else-if="ch.type === 'slack'">Slack webhook</template>
                <template v-else-if="ch.type === 'teams'">Microsoft Teams webhook</template>
                <template v-else-if="ch.type === 'browser'">Dashboard tabs (OS notifications)</template>
                <template v-else>{{ ch.config.url as string }}</template>
                <span v-if="ch.userId === null && authEnabled" class="ml-1 text-primary text-xs">(global)</span>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <UButton
                v-if="canManageChannel(ch)"
                icon="i-lucide-send"
                color="neutral"
                variant="ghost"
                size="sm"
                title="Send test notification"
                :loading="testingChannel === ch.id"
                @click="testChannel(ch.id)"
              />
              <UTooltip v-if="ch.type === 'personal_email'" text="Remove your email in Account settings to disconnect">
                <UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" size="sm" disabled />
              </UTooltip>
              <UButton
                v-else-if="canManageChannel(ch)"
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                size="sm"
                title="Delete channel"
                @click="deleteChannel(ch.id)"
              />
            </div>
          </div>
        </div>
      </SectionCard>

      <!-- Subscriptions -->
      <SectionCard
        icon="i-lucide-bell"
        title="Subscriptions"
        :count="subs.length"
        help="notifications.subscriptions"
        data-tour="notification-subscriptions"
      >
        <div v-if="subs.length === 0" class="text-sm text-muted py-4 text-center">
          No subscriptions yet. Use the <strong>Subscribe</strong> bell on a project page to get started.
        </div>

        <div class="space-y-2">
          <div
            v-for="sub in subs"
            :key="sub.id"
            class="flex items-center gap-3 rounded-lg border border-default px-4 py-3"
            :class="isMuted(sub) ? 'opacity-60' : ''"
          >
            <UIcon :name="channelTypeIcon(sub.channel.type)" class="size-5 text-muted shrink-0" />
            <div class="flex-1 min-w-0 space-y-0.5">
              <div class="font-medium text-sm flex items-center gap-1.5">
                {{ sub.channel.name }}
                <span v-if="sub.userId === null && authEnabled" class="text-primary text-xs">(global)</span>
              </div>
              <div class="text-xs text-muted flex flex-wrap gap-x-3">
                <span v-if="sub.projectId">Project #{{ sub.projectId }}</span>
                <span v-else>All projects</span>
                <span>{{ sub.mode }}</span>
                <span v-if="isMuted(sub)" class="text-warning-500"
                  >Muted until {{ new Date(sub.mutedUntil!).toLocaleDateString() }}</span
                >
                <span
                  v-for="part in describeSubscriptionFilters(sub.filters)"
                  :key="part"
                  data-testid="subscription-filter"
                >
                  {{ part }}
                </span>
              </div>
              <div class="flex flex-wrap gap-1 mt-1">
                <UBadge v-for="e in sub.events ?? []" :key="e" size="xs" variant="soft" color="neutral">
                  {{ eventLabel(e) }}
                </UBadge>
              </div>
            </div>
            <div v-if="canManageSub(sub)" class="flex items-center gap-1">
              <UButton
                :icon="isMuted(sub) ? 'i-lucide-bell' : 'i-lucide-bell-off'"
                color="neutral"
                variant="ghost"
                size="sm"
                :title="isMuted(sub) ? 'Unmute' : 'Mute for 7 days'"
                @click="toggleMute(sub)"
              />
              <UButton
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                size="sm"
                title="Remove subscription"
                @click="deleteSub(sub.id)"
              />
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  </CapabilityDeclinedGuard>
</template>
