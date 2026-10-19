<script setup lang="ts">
import type { ApiKeySummary, ApiKeysResponse, CreateApiKeyResponse } from '~~/types/api';
import { endOfLocalDay, localDateInputValue } from '~/utils/local-date';

/**
 * Manages the API keys of a single user: lists them, creates one (revealing the
 * plaintext once), and revokes them. Keyed by `userId` so the same block serves
 * both the admin Users page (managing any user) and the Account page (a signed-in
 * user managing their own keys). The endpoints already let a non-administrator
 * act on their own keys, so no role logic lives here — the caller decides who
 * may open it.
 */
const props = defineProps<{ userId: number }>();

const toast = useToast();
const { copy } = useCopy();

const apiKeysList = ref<ApiKeySummary[]>([]);

async function loadApiKeys() {
  try {
    const data = await $fetch<ApiKeysResponse>(`/api/users/${props.userId}/api-keys`);
    apiKeysList.value = data.items;
  } catch {
    apiKeysList.value = [];
  }
}

// ── Create key ─────────────────────────────────────────────────────────────
const isCreatingKey = ref(false);
const newKeyName = ref('');
const newKeyExpiry = ref('');
const createdKeyValue = ref<string | null>(null);

// SSR-safe origin for the ready-to-paste reporter snippet shown after creating a key
const serverOrigin = ref('http://localhost:3000');
onMounted(() => {
  serverOrigin.value = window.location.origin;
});
const apiKeyUsageSnippet = computed(
  () => `['@piwitests/reporter', {
  serverUrl: '${serverOrigin.value}',
  apiKey: '${createdKeyValue.value ?? ''}', // or set PIWI_API_KEY and use apiKey: process.env.PIWI_API_KEY
}]`,
);

function startCreateKey() {
  newKeyName.value = '';
  newKeyExpiry.value = '';
  createdKeyValue.value = null;
  isCreatingKey.value = true;
}

function cancelCreateKey() {
  isCreatingKey.value = false;
  createdKeyValue.value = null;
}

async function handleCreateApiKey() {
  try {
    const body: { name: string; expiresAt?: string } = { name: newKeyName.value };
    // The key works through the whole chosen day, in the viewer's time zone.
    const expiresAt = newKeyExpiry.value ? endOfLocalDay(newKeyExpiry.value) : null;
    if (expiresAt) body.expiresAt = expiresAt.toISOString();

    const result = await $fetch<CreateApiKeyResponse>(`/api/users/${props.userId}/api-keys`, {
      method: 'POST',
      body,
    });

    createdKeyValue.value = result.key;
    await loadApiKeys();
  } catch (error: unknown) {
    const errorMessage =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({
      title: 'Failed to create API key',
      description: errorMessage || 'An error occurred',
      color: 'error',
    });
  }
}

function copyKey() {
  copy(createdKeyValue.value, { toast: 'API key copied to clipboard' });
}

function dismissCreatedKey() {
  createdKeyValue.value = null;
  isCreatingKey.value = false;
}

// Reload when the target user changes (e.g. the admin modal switches users) and
// drop any half-filled create form so it never carries over to another user.
watch(
  () => props.userId,
  () => {
    cancelCreateKey();
    loadApiKeys();
  },
  { immediate: true },
);

// ── Revoke key ───────────────────────────────────────────────────────────────
const isRevokeKeyConfirmOpen = ref(false);
const keyToRevoke = ref<ApiKeySummary | null>(null);

function confirmRevokeApiKey(key: ApiKeySummary) {
  keyToRevoke.value = key;
  isRevokeKeyConfirmOpen.value = true;
}

async function handleRevokeApiKey() {
  const key = keyToRevoke.value;
  if (!key) return;
  // keyToRevoke stays set: the closing modal still renders its text.
  isRevokeKeyConfirmOpen.value = false;

  try {
    await $fetch(`/api/users/${props.userId}/api-keys/${key.id}`, {
      method: 'DELETE',
    });

    toast.add({
      title: 'API key revoked',
      description: `Key "${key.name}" has been revoked`,
      color: 'success',
    });

    await loadApiKeys();
  } catch (error: unknown) {
    const errorMessage =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({
      title: 'Failed to revoke API key',
      description: errorMessage || 'An error occurred',
      color: 'error',
    });
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-sm text-muted">
      API keys let the Playwright reporter (and other CI tools) submit test results without a username/password login.
      Each key is shown <strong>only once</strong> at creation time, store it in a CI secret immediately.
    </p>

    <!-- Inline create form -->
    <div v-if="isCreatingKey" class="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-4">
      <!-- Show the new key once, right after creation -->
      <div v-if="createdKeyValue" class="space-y-4">
        <UAlert
          icon="i-lucide-triangle-alert"
          color="warning"
          variant="subtle"
          title="Save your API key now"
          description="This key will never be shown again. Copy it and store it in your CI secret manager immediately."
        />
        <div class="rounded-lg bg-elevated p-3 font-mono text-sm break-all select-all">
          {{ createdKeyValue }}
        </div>
        <div class="flex gap-2">
          <UButton label="Copy to clipboard" icon="i-lucide-clipboard" color="primary" size="sm" @click="copyKey" />
          <UButton label="Done" color="neutral" variant="ghost" size="sm" @click="dismissCreatedKey" />
        </div>

        <div>
          <p class="text-xs font-medium text-muted mb-2">Use it in your reporter config</p>
          <CodeBlock :code="apiKeyUsageSnippet" lang="typescript" />
        </div>
      </div>

      <!-- Key creation form -->
      <div v-else class="space-y-3">
        <h4 class="text-sm font-medium text-highlighted">Create new API key</h4>
        <UFormField label="Key name" name="name" required>
          <UInput v-model="newKeyName" placeholder="e.g. GitHub Actions CI" size="sm" class="w-full" />
        </UFormField>

        <UFormField label="Expires at (optional)" name="expiresAt">
          <UInput v-model="newKeyExpiry" type="date" size="sm" :min="localDateInputValue()" />
        </UFormField>

        <div class="flex gap-2">
          <UButton
            label="Generate key"
            icon="i-lucide-key"
            size="sm"
            :disabled="!newKeyName.trim()"
            @click="handleCreateApiKey"
          />
          <UButton color="neutral" variant="ghost" label="Cancel" size="sm" @click="cancelCreateKey" />
        </div>
      </div>
    </div>

    <!-- Key list -->
    <div v-if="apiKeysList.length > 0" class="space-y-2">
      <div
        v-for="key in apiKeysList"
        :key="key.id"
        class="flex items-center justify-between gap-3 rounded-lg border border-default px-4 py-3"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-key" class="text-muted shrink-0" />
            <span class="font-medium truncate">{{ key.name }}</span>
          </div>
          <div class="text-xs text-muted mt-1 flex flex-wrap gap-x-4">
            <span v-if="key.oauth" title="An MCP client that signed in through OAuth: it has no key to copy"
              >MCP client, signed in through OAuth</span
            >
            <span v-else
              >Prefix: <code class="font-mono">pd_{{ key.keyPrefix }}…</code></span
            >
            <span>Created: <ClientDate :date="key.createdAt" date-only /></span>
            <span v-if="key.lastUsedAt">Last used: <ClientDate :date="key.lastUsedAt" date-only /></span>
            <span v-else class="italic">Never used</span>
            <span v-if="key.expiresAt" :class="new Date(key.expiresAt) < new Date() ? 'text-error' : ''">
              Expires: <ClientDate :date="key.expiresAt" date-only />
            </span>
          </div>
        </div>
        <UButton
          icon="i-lucide-trash-2"
          color="error"
          variant="ghost"
          size="sm"
          title="Revoke key"
          @click="confirmRevokeApiKey(key)"
        />
      </div>
    </div>

    <div v-else-if="!isCreatingKey" class="text-center text-muted py-6 text-sm">
      No API keys yet. Create one to allow CI access.
    </div>

    <!-- Create action -->
    <div v-if="!isCreatingKey" class="flex justify-end">
      <UButton label="Create API key" icon="i-lucide-plus" size="sm" @click="startCreateKey" />
    </div>

    <!-- Revoke confirmation -->
    <ClientOnly>
      <UModal :open="isRevokeKeyConfirmOpen" title="Revoke API key" @update:open="isRevokeKeyConfirmOpen = $event">
        <template #body>
          <p v-if="keyToRevoke?.oauth">
            Disconnect <strong>"{{ keyToRevoke?.name }}"</strong>? The MCP client loses access at its next request and
            has to sign in again.
          </p>
          <p v-else>
            Revoke API key <strong>"{{ keyToRevoke?.name }}"</strong>? Any CI pipeline using it will stop working
            immediately.
          </p>
        </template>

        <template #footer>
          <UButton color="neutral" variant="ghost" label="Cancel" @click="isRevokeKeyConfirmOpen = false" />
          <UButton color="error" label="Revoke" icon="i-lucide-trash-2" @click="handleRevokeApiKey" />
        </template>
      </UModal>
    </ClientOnly>
  </div>
</template>
