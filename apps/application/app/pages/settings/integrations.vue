<script setup lang="ts">
import { INTEGRATION_PROVIDER_LIST, type IntegrationProviderName } from '#shared/integrations/registry';
import type { ConnectionSummary, ConnectionTestResult } from '#shared/integrations/types';
import { ATLASSIAN_API_TOKENS_URL, jiraWebhooksAdminUrl, tokenExpiry } from '#shared/integrations/jira-setup';
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';
import { looksPrivateHost } from '#shared/utils/private-host';
import type { ApiResponse } from '~~/types/api';
import { trackerSyncToast } from '~/utils/tracker-sync';

const toast = useToast();
const { canAnywhere } = useAuth();
const canManageConnections = computed(() => canAnywhere('connections:manage'));
const { app: appConfig } = useRuntimeConfig();
const { data, refresh } = await useFetch<{ connections: ConnectionSummary[]; canStoreSecrets: boolean }>(
  '/api/integrations/connections',
  { default: () => ({ connections: [] as ConnectionSummary[], canStoreSecrets: true }) },
);

const connections = computed(() => data.value?.connections ?? []);
// The create-issue entry points read the shared tracker status: read it again
// when a connection is added or removed, so they follow without a reload.
const { refresh: refreshTrackerStatus } = useTrackerStatus();
watch(
  () => connections.value.map((c) => c.id).join(','),
  () => void refreshTrackerStatus(),
);
const canStoreSecrets = computed(() => data.value?.canStoreSecrets ?? true);
function connectionsFor(provider: IntegrationProviderName): ConnectionSummary[] {
  return connections.value.filter((c) => c.provider === provider);
}

/** Env vars that back an environment-managed connection, per provider. */
const ENV_VARS_BY_PROVIDER: Partial<Record<IntegrationProviderName, PiwiEnvVarName[]>> = {
  jira: ['PIWI_JIRA_BASE_URL', 'PIWI_JIRA_EMAIL', 'PIWI_JIRA_API_TOKEN'],
};

function statusColor(status: ConnectionSummary['status']): 'success' | 'error' | 'neutral' {
  if (status === 'ok') return 'success';
  if (status === 'failed') return 'error';
  return 'neutral';
}
function statusLabel(status: ConnectionSummary['status']): string {
  if (status === 'ok') return 'Verified';
  if (status === 'failed') return 'Failed';
  return 'Unverified';
}

/** How the connection's token authenticates, once a test or the form found out. */
function tokenKindLine(conn: ConnectionSummary): string | null {
  const tested = testResults[conn.id];
  const stored = conn.config?.tokenKind ?? (conn.config?.cloudId ? 'scoped' : null);
  const kind = tested?.ok ? tested.tokenKind : stored;
  if (kind === 'scoped') return 'Scoped token, called through api.atlassian.com';
  if (kind === 'classic') return 'Classic token';
  return null;
}

/** The token-expiry reminder for a connection, when an expiry date was recorded. */
function expiryLine(conn: ConnectionSummary): { text: string; warn: boolean } | null {
  const expiry = tokenExpiry(conn.config?.tokenExpiresOn);
  if (!expiry) return null;
  if (expiry.state === 'expired') return { text: 'The API token has expired.', warn: true };
  const days = `${expiry.daysLeft} day${expiry.daysLeft === 1 ? '' : 's'}`;
  return { text: `The API token expires in ${days}.`, warn: expiry.state === 'soon' };
}

// ── Connect / edit form ────────────────────────────────────────────────────
const formProvider = ref<IntegrationProviderName | null>(null);
const editingConnection = ref<ConnectionSummary | null>(null);

function openCreate(provider: IntegrationProviderName) {
  formProvider.value = provider;
  editingConnection.value = null;
}

function openEdit(conn: ConnectionSummary) {
  formProvider.value = conn.provider;
  editingConnection.value = conn;
}

function closeForm() {
  formProvider.value = null;
  editingConnection.value = null;
}

async function onSaved() {
  closeForm();
  await refresh();
}

// ── Test / delete ──────────────────────────────────────────────────────────
const testing = ref<number | null>(null);
const testResults = reactive<Record<number, ConnectionTestResult>>({});

async function testConnection(conn: ConnectionSummary) {
  testing.value = conn.id;
  try {
    testResults[conn.id] = await $fetch<ConnectionTestResult>(`/api/integrations/connections/${conn.id}/test`, {
      method: 'POST',
    });
    await refresh();
  } catch (err) {
    testResults[conn.id] = { ok: false, error: errorMessage(err) };
  } finally {
    testing.value = null;
  }
}

// ── Inbound webhook token ────────────────────────────────────────────────────
const webhooking = ref<number | null>(null);
const webhookUrls = reactive<Record<number, string>>({});
async function generateWebhook(conn: ConnectionSummary) {
  webhooking.value = conn.id;
  try {
    const { url } = await $fetch<{ token: string; url: string }>(
      `/api/integrations/connections/${conn.id}/webhook-token`,
      { method: 'POST' },
    );
    webhookUrls[conn.id] = absoluteUrl(url);
    await refresh();
    toast.add({ title: 'Webhook enabled', description: 'Copy the URL now — it is shown once.', color: 'success' });
  } catch (err) {
    toast.add({ title: 'Could not enable the webhook', description: errorMessage(err), color: 'error' });
  } finally {
    webhooking.value = null;
  }
}

const webhookToDisable = ref<ConnectionSummary | null>(null);
const isDisableWebhookOpen = ref(false);
const disablingWebhook = ref<number | null>(null);

function askDisableWebhook(conn: ConnectionSummary) {
  webhookToDisable.value = conn;
  isDisableWebhookOpen.value = true;
}

async function confirmDisableWebhook() {
  const conn = webhookToDisable.value;
  isDisableWebhookOpen.value = false;
  if (!conn) return;
  disablingWebhook.value = conn.id;
  try {
    await $fetch<
      ApiResponse<typeof import('~~/server/api/integrations/connections/[id]/webhook-token.delete').default>
    >(`/api/integrations/connections/${conn.id}/webhook-token`, { method: 'DELETE' });
    delete webhookUrls[conn.id];
    await refresh();
    toast.add({
      title: 'Webhook disabled',
      description: 'Piwi ignores calls to its URL; the status sync keeps the statuses current.',
      color: 'success',
    });
  } catch (err) {
    toast.add({ title: 'Could not disable the webhook', description: errorMessage(err), color: 'error' });
  } finally {
    disablingWebhook.value = null;
  }
}

/** The server answers with a path when `PIWI_SITE_URL` is unset; Jira needs the full address. */
function absoluteUrl(url: string): string {
  if (!url.startsWith('/')) return url;
  const base = appConfig.baseURL.replace(/\/+$/, '');
  return `${window.location.origin}${base}${url}`;
}

/** Whether Atlassian Cloud could reach a URL: not a loopback, private or local-only host. */
function reachableFromCloud(url: string): boolean {
  try {
    return !looksPrivateHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

// ── Status sync ─────────────────────────────────────────────────────────────
const syncing = ref(false);
async function syncNow() {
  syncing.value = true;
  try {
    const result = await $fetch<ApiResponse<typeof import('~~/server/api/integrations/sync.post').default>>(
      '/api/integrations/sync',
      { method: 'POST' },
    );
    toast.add(trackerSyncToast(result));
    await refresh();
  } catch (err) {
    toast.add({ title: 'Could not sync the statuses', description: errorMessage(err), color: 'error' });
  } finally {
    syncing.value = false;
  }
}

const deleting = ref<number | null>(null);
async function removeConnection(conn: ConnectionSummary) {
  deleting.value = conn.id;
  try {
    await $fetch(`/api/integrations/connections/${conn.id}`, { method: 'DELETE' });
    toast.add({ title: 'Connection removed', color: 'success' });
    await refresh();
  } catch (err) {
    toast.add({ title: 'Delete failed', description: errorMessage(err), color: 'error' });
  } finally {
    deleting.value = null;
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'data' in err) {
    const data = (err as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
</script>

<template>
  <CapabilityDeclinedGuard capability="integrations" label="Integrations">
    <div class="space-y-6" data-shot="integrations-settings">
      <SectionCard
        v-for="provider in INTEGRATION_PROVIDER_LIST"
        :key="provider.name"
        :icon="provider.icon"
        :title="provider.label"
        help="settings.integrations"
      >
        <template #subtitle>
          Connect {{ provider.label }} so pinned links unfurl with a title and status, and refresh through the
          connection.
        </template>
        <template v-if="canManageConnections && connectionsFor(provider.name).length > 0" #actions>
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-refresh-cw"
            label="Sync now"
            title="Read the status of every linked issue that is due for a refresh, as the scheduled sync does"
            :loading="syncing"
            @click="syncNow"
          />
        </template>

        <div class="space-y-4">
          <!-- Existing connections -->
          <EmptyState
            v-if="connectionsFor(provider.name).length === 0 && formProvider !== provider.name"
            icon="i-lucide-plug-zap"
            :text="`No ${provider.label} connection yet.`"
          />

          <ul v-else class="space-y-3">
            <li
              v-for="conn in connectionsFor(provider.name)"
              :key="conn.id"
              class="rounded-lg border border-default p-3 sm:p-4 space-y-3"
            >
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="text-sm font-medium text-highlighted">{{ conn.name }}</span>
                <UBadge :color="statusColor(conn.status)" variant="subtle" size="sm">{{
                  statusLabel(conn.status)
                }}</UBadge>
                <EnvManagedBadge v-if="conn.managedBy === 'env'" :env-vars="ENV_VARS_BY_PROVIDER[provider.name]" />
              </div>
              <p class="text-xs text-muted font-mono break-all">
                <OutboundLink :href="conn.baseUrl">{{ conn.baseUrl }}</OutboundLink>
              </p>
              <p v-if="conn.credentialValues.email || tokenKindLine(conn)" class="text-xs text-muted break-all">
                {{ [conn.credentialValues.email, tokenKindLine(conn)].filter(Boolean).join(' · ') }}
              </p>
              <p
                v-if="expiryLine(conn)"
                class="text-xs"
                :class="expiryLine(conn)!.warn ? 'text-warning' : 'text-muted'"
                data-testid="token-expiry"
              >
                {{ expiryLine(conn)!.text }}
                <OutboundLink v-if="expiryLine(conn)!.warn" :href="ATLASSIAN_API_TOKENS_URL"
                  >Create a new one</OutboundLink
                >
              </p>

              <ErrorText
                v-if="conn.status === 'failed' && conn.lastError && !testResults[conn.id]"
                :text="conn.lastError"
              />
              <CheckResultLine
                v-if="testResults[conn.id]?.ok"
                state="ok"
                :text="`Signed in as ${testResults[conn.id]?.account?.displayName || 'the account'}.`"
              />
              <CheckResultLine
                v-else-if="testResults[conn.id]"
                state="error"
                :text="testResults[conn.id]?.error ?? 'Test failed'"
                :hint="testResults[conn.id]?.hint"
              />

              <div class="flex flex-wrap items-center gap-2">
                <UButton
                  color="neutral"
                  variant="outline"
                  size="sm"
                  icon="i-lucide-plug"
                  :loading="testing === conn.id"
                  label="Test connection"
                  @click="testConnection(conn)"
                />
                <template v-if="conn.managedBy === 'db'">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    icon="i-lucide-pencil"
                    label="Edit"
                    @click="openEdit(conn)"
                  />
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    icon="i-lucide-trash-2"
                    label="Remove"
                    :loading="deleting === conn.id"
                    @click="removeConnection(conn)"
                  />
                </template>
                <UButton
                  v-if="provider.name === 'jira'"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  icon="i-lucide-webhook"
                  :label="conn.hasWebhookToken ? 'Regenerate webhook' : 'Enable webhook'"
                  :loading="webhooking === conn.id"
                  @click="generateWebhook(conn)"
                />
                <UButton
                  v-if="provider.name === 'jira' && conn.hasWebhookToken && canManageConnections"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  icon="i-lucide-webhook-off"
                  label="Disable webhook"
                  :loading="disablingWebhook === conn.id"
                  @click="askDisableWebhook(conn)"
                />
              </div>

              <!-- The webhook URL, shown once after generating. -->
              <div v-if="webhookUrls[conn.id]" class="rounded-lg border border-default p-3 space-y-2">
                <p class="text-sm text-highlighted">Copy this URL now: it is shown once.</p>
                <CodeBlock :code="webhookUrls[conn.id]!" lang="text" />
                <CheckResultLine
                  v-if="!reachableFromCloud(webhookUrls[conn.id]!)"
                  state="warning"
                  text="Atlassian Cloud cannot reach this address."
                  hint="Set PIWI_SITE_URL to the address Piwi is reachable at from the internet, or rely on the status sync, which needs no webhook."
                />
                <ol class="list-decimal space-y-1 ps-5 text-sm text-highlighted leading-relaxed">
                  <li>
                    Open <OutboundLink :href="jiraWebhooksAdminUrl(conn.baseUrl)">Jira’s webhooks page</OutboundLink> (a
                    Jira administrator) and choose <span class="font-semibold">Create a webhook</span>.
                  </li>
                  <li>Paste the URL, and tick <span class="font-semibold">Issue → updated</span>.</li>
                  <li>Optionally, limit it with a JQL filter to the projects Piwi files into.</li>
                </ol>
              </div>

              <IntegrationActivityList :connection-id="conn.id" />
            </li>
          </ul>

          <!-- Connect / edit form -->
          <JiraConnectionForm
            v-if="formProvider === provider.name && provider.name === 'jira'"
            :key="editingConnection?.id ?? 'new'"
            :connection="editingConnection"
            :can-store-secrets="canStoreSecrets"
            @saved="onSaved"
            @cancel="closeForm"
          />

          <div v-else-if="formProvider === null">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-plus"
              :label="`Connect ${provider.label}`"
              @click="openCreate(provider.name)"
            />
          </div>
        </div>

        <template #footer>
          <p class="text-xs text-muted">
            A connection base URL is administrator-supplied and trusted, so a self-hosted tracker on a private host
            works.
            <HelpHint topic="settings.integrations.private-host" />
          </p>
        </template>
      </SectionCard>
    </div>

    <ClientOnly>
      <UModal :open="isDisableWebhookOpen" title="Disable the webhook" @update:open="isDisableWebhookOpen = $event">
        <template #body>
          <p class="text-sm text-highlighted leading-relaxed">
            Disable the inbound webhook of <strong>{{ webhookToDisable?.name }}</strong
            >? Piwi ignores Jira's calls to its URL from now on, and the statuses refresh on the status sync only.
            Enable it again to get a new URL.
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" label="Cancel" @click="isDisableWebhookOpen = false" />
            <UButton color="error" label="Disable webhook" icon="i-lucide-webhook-off" @click="confirmDisableWebhook" />
          </div>
        </template>
      </UModal>
    </ClientOnly>
  </CapabilityDeclinedGuard>
</template>
