<script setup lang="ts">
const toast = useToast();
const route = useRoute();
const router = useRouter();
const config = useRuntimeConfig();

interface MeUser {
  id: number;
  username: string;
  role: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  oauthProvider: string | null;
  hasPassword: boolean;
}

const { data: me, refresh } = await useFetch<{ authenticated: boolean; user: MeUser | null }>('/api/auth/me');

const linkedProvider = computed(() => me.value?.user?.oauthProvider ?? null);
const hasPassword = computed(() => Boolean(me.value?.user?.hasPassword));
// An OAuth-only account (no password) is fully provider-managed: email and
// password are owned by the provider and can't be edited here.
const isOAuthOnly = computed(() => Boolean(linkedProvider.value) && !hasPassword.value);

// Providers configured on this instance (empty in demo mode).
const providerMeta: Record<string, { label: string; icon: string }> = {
  google: { label: 'Google', icon: 'i-lucide-chrome' },
  github: { label: 'GitHub', icon: 'i-lucide-github' },
};
const oauthProviders = computed<string[]>(() => {
  if (config.public.demoMode) return [];
  return ((config.public.oauthProviders as string[]) || []).filter((p) => providerMeta[p]);
});

// Display name form
const nameField = ref('');
const savingName = ref(false);

// Email form
const emailField = ref('');
const savingEmail = ref(false);
const sendingVerify = ref(false);

// Password form
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const changingPassword = ref(false);

// Provider disconnect
const disconnecting = ref('');

watch(
  () => me.value?.user,
  (u) => {
    if (u) {
      nameField.value = u.name || '';
      emailField.value = u.email || '';
    }
  },
  { immediate: true },
);

const LINK_ERRORS: Record<string, string> = {
  'already-linked': 'That provider account is already linked to another user.',
  'link-requires-login': 'Please sign in before connecting a provider.',
  'domain-not-allowed': 'That account’s email domain is not allowed.',
  'org-not-allowed': 'You are not a member of an allowed organization.',
  'invalid-state': 'Connecting failed (invalid state). Please try again.',
  'access-denied': 'Authorization was cancelled.',
  'oauth-failed': 'Connecting the provider failed.',
};

onMounted(() => {
  if (route.query.verified) {
    toast.add({ title: 'Email verified', color: 'success' });
  }
  if (route.query.linked) {
    toast.add({ title: 'Account connected', color: 'success' });
    refresh();
  }
  const err = route.query.error as string | undefined;
  if (err) {
    toast.add({
      title: 'Could not connect account',
      description: LINK_ERRORS[err] || 'Please try again.',
      color: 'error',
    });
  }
  if (route.query.linked || route.query.error || route.query.verified) {
    // Clean the query so a refresh doesn't replay the toast.
    router.replace({ query: {} });
  }
});

async function saveName() {
  savingName.value = true;
  try {
    await $fetch(`/api/users/${me.value?.user?.id}`, { method: 'PATCH', body: { name: nameField.value || null } });
    await refresh();
    toast.add({ title: 'Display name updated', color: 'success' });
  } catch (e) {
    toast.add({
      title: 'Failed to update display name',
      description: String((e as Error)?.message ?? e),
      color: 'error',
    });
  } finally {
    savingName.value = false;
  }
}

async function saveEmail() {
  savingEmail.value = true;
  try {
    await $fetch(`/api/users/${me.value?.user?.id}`, { method: 'PATCH', body: { email: emailField.value || null } });
    await refresh();
    toast.add({ title: 'Email updated', color: 'success' });
  } catch (e) {
    toast.add({ title: 'Failed to update email', description: String((e as Error)?.message ?? e), color: 'error' });
  } finally {
    savingEmail.value = false;
  }
}

async function sendVerification() {
  sendingVerify.value = true;
  try {
    await $fetch('/api/auth/send-verify-email', { method: 'POST' });
    toast.add({ title: 'Verification email sent', description: 'Check your inbox.', color: 'success' });
  } catch (e) {
    toast.add({
      title: 'Failed to send verification',
      description: String((e as Error)?.message ?? e),
      color: 'error',
    });
  } finally {
    sendingVerify.value = false;
  }
}

async function changePassword() {
  if (newPassword.value.length < 8) {
    toast.add({ title: 'Password too short', description: 'At least 8 characters required', color: 'error' });
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    toast.add({ title: 'Passwords do not match', color: 'error' });
    return;
  }
  changingPassword.value = true;
  try {
    await $fetch('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
    });
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    toast.add({ title: 'Password changed', color: 'success' });
  } catch (e) {
    toast.add({ title: 'Failed to change password', description: String((e as Error)?.message ?? e), color: 'error' });
  } finally {
    changingPassword.value = false;
  }
}

function connectProvider(provider: string) {
  window.location.href = `/api/auth/oauth/${provider}/login?link=1`;
}

async function disconnectProvider(provider: string) {
  disconnecting.value = provider;
  try {
    await $fetch(`/api/auth/oauth/${provider}/unlink`, { method: 'POST' });
    await refresh();
    toast.add({ title: 'Account disconnected', color: 'success' });
  } catch (e) {
    toast.add({
      title: 'Failed to disconnect',
      description: String((e as { data?: { message?: string } })?.data?.message ?? (e as Error)?.message ?? e),
      color: 'error',
    });
  } finally {
    disconnecting.value = '';
  }
}

const authEnabled = computed(() => config.public.authEnabled);
</script>

<template>
  <div class="space-y-6" data-tour="account-page">
    <UAlert
      v-if="!authEnabled"
      color="warning"
      icon="i-lucide-lock-open"
      title="Authentication disabled"
      description="Enable PIWI_AUTH_ENABLED=true to manage your account."
    >
      <template #description>
        <span class="inline-flex items-center gap-1.5">
          Enable <code class="font-mono text-xs">PIWI_AUTH_ENABLED=true</code> to manage your account.
          <HelpHint topic="settings.auth-toggle" />
        </span>
      </template>
    </UAlert>

    <template v-else-if="me?.user">
      <!-- Display name section -->
      <SectionCard
        icon="i-lucide-user"
        title="Display name"
        help="account.display-name"
        data-tour="account-display-name"
      >
        <UFormField label="Display name" name="name">
          <UInput v-model="nameField" placeholder="Your display name (optional)" class="w-full" />
        </UFormField>

        <template #footer>
          <div class="flex justify-end">
            <UButton color="primary" :loading="savingName" icon="i-lucide-save" @click="saveName"> Save name </UButton>
          </div>
        </template>
      </SectionCard>

      <!-- Email section -->
      <SectionCard icon="i-lucide-mail" title="Email address" help="account.email" data-tour="account-email">
        <div class="space-y-3">
          <div
            v-if="me.user.emailVerified"
            class="flex items-center gap-2 text-sm text-success-600 dark:text-success-400"
          >
            <UIcon name="i-lucide-circle-check-big" class="size-4" />
            Verified
          </div>
          <div v-else-if="me.user.email" class="flex items-center gap-2 text-sm text-warning-600 dark:text-warning-400">
            <UIcon name="i-lucide-circle-alert" class="size-4" />
            Not verified
            <UButton
              v-if="!isOAuthOnly"
              size="xs"
              variant="soft"
              color="warning"
              :loading="sendingVerify"
              @click="sendVerification"
            >
              Send verification email
            </UButton>
          </div>

          <UFormField label="Email" name="email">
            <UInput
              v-model="emailField"
              type="email"
              placeholder="you@example.com"
              :disabled="isOAuthOnly"
              class="w-full"
            />
          </UFormField>

          <p v-if="isOAuthOnly" class="text-xs text-gray-400">
            Email is managed by <strong>{{ linkedProvider }}</strong
            >.
          </p>
        </div>

        <template v-if="!isOAuthOnly" #footer>
          <div class="flex justify-end">
            <UButton color="primary" :loading="savingEmail" icon="i-lucide-save" @click="saveEmail">
              Save email
            </UButton>
          </div>
        </template>
      </SectionCard>

      <!-- Connected accounts section -->
      <SectionCard
        v-if="oauthProviders.length > 0"
        icon="i-lucide-link"
        title="Connected accounts"
        help="account.connected-accounts"
      >
        <div class="space-y-3">
          <div
            v-for="p in oauthProviders"
            :key="p"
            class="flex items-center justify-between gap-3 rounded-md border border-default px-3 py-2"
          >
            <div class="flex items-center gap-2 text-sm">
              <UIcon :name="providerMeta[p]!.icon" class="size-5" />
              <span>{{ providerMeta[p]!.label }}</span>
              <UBadge v-if="linkedProvider === p" color="success" variant="subtle" size="sm">Connected</UBadge>
            </div>

            <template v-if="linkedProvider === p">
              <UButton
                v-if="hasPassword"
                size="xs"
                color="error"
                variant="soft"
                icon="i-lucide-unlink"
                :loading="disconnecting === p"
                @click="disconnectProvider(p)"
              >
                Disconnect
              </UButton>
              <span v-else class="text-xs text-gray-400" title="Set a password first to keep a way to sign in">
                Set a password to disconnect
              </span>
            </template>
            <UButton
              v-else-if="!linkedProvider"
              size="xs"
              variant="outline"
              color="neutral"
              icon="i-lucide-plus"
              @click="connectProvider(p)"
            >
              Connect
            </UButton>
            <span v-else class="text-xs text-gray-400">Another provider is connected</span>
          </div>
          <p class="text-xs text-gray-400">One provider can be connected per account.</p>
        </div>
      </SectionCard>

      <!-- Change password section -->
      <SectionCard
        v-if="!isOAuthOnly"
        icon="i-lucide-lock"
        title="Change password"
        help="account.password"
        data-tour="account-password"
      >
        <div class="space-y-4">
          <UFormField label="Current password" name="currentPassword">
            <UInput
              v-model="currentPassword"
              type="password"
              placeholder="Current password"
              autocomplete="current-password"
              class="w-full"
            />
          </UFormField>
          <UFormField label="New password" name="newPassword" description="Minimum 8 characters">
            <UInput
              v-model="newPassword"
              type="password"
              placeholder="New password"
              autocomplete="new-password"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Confirm new password" name="confirmPassword">
            <UInput
              v-model="confirmPassword"
              type="password"
              placeholder="Repeat new password"
              autocomplete="new-password"
              class="w-full"
            />
          </UFormField>
        </div>

        <template #footer>
          <div class="flex justify-end">
            <UButton color="primary" :loading="changingPassword" icon="i-lucide-key-round" @click="changePassword">
              Change password
            </UButton>
          </div>
        </template>
      </SectionCard>

      <SectionCard v-else icon="i-lucide-lock" title="Password">
        <p class="text-sm text-gray-500">
          Your account is managed by <strong>{{ linkedProvider }}</strong
          >. Password management is handled by that provider.
        </p>
      </SectionCard>

      <!-- API keys section -->
      <SectionCard
        icon="i-lucide-key"
        title="API keys"
        help="settings.api-keys"
        data-shot="account-api-keys"
        data-tour="account-api-keys"
      >
        <ApiKeysManager :user-id="me.user.id" />
      </SectionCard>
    </template>
  </div>
</template>
