<script setup lang="ts">
import { safeReturnPath } from '#shared/return-path';

const { login } = useAuth();
const router = useRouter();
const route = useRoute();
const toast = useToast();
const config = useRuntimeConfig();

const state = reactive({
  username: '',
  password: '',
});

const loading = ref(false);
const error = ref('');

// Where to land after signing in: a same-origin path handed over by a link
// that needed a session first (the reporter's per-failure links), else home.
function redirectTarget(): string {
  return safeReturnPath(route.query.redirect) ?? '/';
}

// Auth enabled and no administrator yet (a fresh instance, or only OAuth
// members): show a first-admin setup form instead (mirrors the documented
// `POST /api/auth/setup` curl flow, but reachable from the UI).
const needsSetup = ref<boolean | null>(null);
// With PIWI_SETUP_TOKEN set, only someone who can read the server's settings may create the first admin.
const setupTokenRequired = ref(false);
const setupState = reactive({
  username: '',
  password: '',
  confirmPassword: '',
  name: '',
  setupToken: '',
});
const setupLoading = ref(false);
const setupError = ref('');

onMounted(async () => {
  if (config.public.demoMode) {
    needsSetup.value = false;
    return;
  }
  try {
    const status = await $fetch<{ needsSetup: boolean; setupTokenRequired?: boolean }>('/api/auth/setup');
    needsSetup.value = status.needsSetup;
    setupTokenRequired.value = Boolean(status.setupTokenRequired);
  } catch {
    needsSetup.value = false;
  }
});

async function handleSetup() {
  if (!setupState.username || !setupState.password) {
    setupError.value = 'Please choose a username and password';
    return;
  }
  // Mirror the server's validation rules so their violations read as field
  // hints instead of a generic "Invalid request body" error.
  if (setupState.username.length < 3) {
    setupError.value = 'Username must be at least 3 characters';
    return;
  }
  if (setupState.password.length < 8) {
    setupError.value = 'Password must be at least 8 characters';
    return;
  }
  if (setupState.password !== setupState.confirmPassword) {
    setupError.value = 'Passwords do not match';
    return;
  }
  if (setupTokenRequired.value && !setupState.setupToken.trim()) {
    setupError.value = 'Enter the setup token (PIWI_SETUP_TOKEN on the server)';
    return;
  }

  setupLoading.value = true;
  setupError.value = '';

  try {
    await $fetch('/api/auth/setup', {
      method: 'POST',
      body: {
        username: setupState.username,
        password: setupState.password,
        name: setupState.name || undefined,
        setupToken: setupTokenRequired.value ? setupState.setupToken.trim() : undefined,
      },
    });
    await login(setupState.username, setupState.password);
    toast.add({ title: 'Admin account created', description: "You're signed in.", color: 'success' });
    router.push('/');
  } catch (err: unknown) {
    const errorMessage =
      err && typeof err === 'object' && 'data' in err ? (err.data as { message?: string })?.message : undefined;
    setupError.value = errorMessage || 'Failed to create the admin account';
    toast.add({ title: 'Setup failed', description: setupError.value, color: 'error' });
  } finally {
    setupLoading.value = false;
  }
}

const oauthProviders = computed(() => {
  if (config.public.demoMode) return [];
  return (config.public.oauthProviders as string[]) || [];
});

// Check for OAuth error from callback redirect
onMounted(() => {
  const oauthError = route.query.error as string | undefined;
  if (oauthError) {
    const messages: Record<string, string> = {
      'access-denied': 'Access was denied',
      'invalid-state': 'Authentication failed (invalid state)',
      'missing-code': 'Authentication failed (missing code)',
      'oauth-failed': 'OAuth authentication failed',
      'account-exists': 'This email is already linked to a different sign-in method. Sign in with that method instead.',
      'email-unverified':
        'An account with this email has not verified it yet, so it was not linked. Sign in with its password (or accept your invite first), then connect this provider from Account settings.',
      'domain-not-allowed': 'Your email domain is not allowed to sign in here.',
      'org-not-allowed': 'You are not a member of an allowed organization.',
      'link-requires-login': 'Please sign in before connecting a provider.',
      'auth-disabled': 'Authentication is not enabled',
      'invalid-provider': 'Invalid OAuth provider',
    };
    error.value = messages[oauthError] || 'Authentication failed';
  }
});

async function handleLogin() {
  if (!state.username || !state.password) {
    error.value = 'Please enter username and password';
    return;
  }

  loading.value = true;
  error.value = '';

  try {
    await login(state.username, state.password);
    toast.add({
      title: 'Login successful',
      color: 'success',
    });
    router.push(redirectTarget());
  } catch (err: unknown) {
    const errorMessage =
      err && typeof err === 'object' && 'data' in err ? (err.data as { message?: string })?.message : undefined;
    error.value = errorMessage || 'Invalid username or password';
    toast.add({
      title: 'Login failed',
      description: error.value,
      color: 'error',
    });
  } finally {
    loading.value = false;
  }
}

function startOAuth(provider: string) {
  const target = redirectTarget();
  const query = target === '/' ? '' : `?redirect=${encodeURIComponent(target)}`;
  window.location.href = `/api/auth/oauth/${provider}/login${query}`;
}

definePageMeta({
  layout: false,
});
</script>

<template>
  <div class="min-h-screen flex flex-col items-center justify-center bg-elevated/50 gap-6 px-4">
    <img src="/logo-wide.svg" alt="Piwi Dashboard" class="h-16 rounded-xl" />

    <UCard v-if="needsSetup === null" class="w-full max-w-md">
      <LoadingState text="Loading…" />
    </UCard>

    <UCard v-else-if="needsSetup" class="w-full max-w-md">
      <template #header>
        <h1 class="text-xl font-semibold">Create the first admin account</h1>
        <p class="text-sm text-muted mt-1">
          Authentication is enabled and no administrator exists yet. Create the administrator account to sign in.
        </p>
      </template>

      <UAlert v-if="setupError" color="error" :title="setupError" variant="subtle" class="mb-4" />

      <form class="space-y-4" @submit.prevent="handleSetup">
        <UFormField
          v-if="setupTokenRequired"
          label="Setup token"
          name="setupToken"
          help="The value of PIWI_SETUP_TOKEN in the server's settings."
          required
        >
          <UInput
            v-model="setupState.setupToken"
            type="password"
            placeholder="Paste the setup token"
            autocomplete="off"
            :disabled="setupLoading"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Username" name="username" required>
          <UInput
            v-model="setupState.username"
            type="text"
            placeholder="Choose a username"
            autocomplete="username"
            :disabled="setupLoading"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Name" name="name">
          <UInput
            v-model="setupState.name"
            type="text"
            placeholder="Administrator (optional)"
            autocomplete="name"
            :disabled="setupLoading"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="setupState.password"
            type="password"
            placeholder="Choose a password (min. 8 characters)"
            autocomplete="new-password"
            :disabled="setupLoading"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Confirm password" name="confirmPassword" required>
          <UInput
            v-model="setupState.confirmPassword"
            type="password"
            placeholder="Re-enter the password"
            autocomplete="new-password"
            :disabled="setupLoading"
            class="w-full"
          />
        </UFormField>

        <UButton type="submit" block :loading="setupLoading" :disabled="setupLoading"> Create admin account </UButton>
      </form>
    </UCard>

    <UCard v-else class="w-full max-w-md">
      <template #header>
        <h1 class="text-xl font-semibold">Sign in to your account</h1>
      </template>

      <UAlert v-if="error" color="error" :title="error" variant="subtle" class="mb-4" />

      <!-- OAuth buttons -->
      <div v-if="oauthProviders.length > 0" class="space-y-2 mb-4">
        <UButton
          v-if="oauthProviders.includes('google')"
          block
          color="neutral"
          variant="outline"
          @click="startOAuth('google')"
        >
          <template #leading>
            <UIcon name="i-lucide-chrome" class="size-5" />
          </template>
          Sign in with Google
        </UButton>

        <UButton
          v-if="oauthProviders.includes('github')"
          block
          color="neutral"
          variant="outline"
          @click="startOAuth('github')"
        >
          <template #leading>
            <UIcon name="i-lucide-github" class="size-5" />
          </template>
          Sign in with GitHub
        </UButton>

        <USeparator v-if="oauthProviders.length > 0" label="or continue with password" class="my-4" />
      </div>

      <!-- Password login form -->
      <form class="space-y-4" @submit.prevent="handleLogin">
        <UFormField label="Username" name="username" required>
          <UInput
            v-model="state.username"
            type="text"
            placeholder="Enter your username"
            autocomplete="username"
            :disabled="loading"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="state.password"
            type="password"
            placeholder="Enter your password"
            autocomplete="current-password"
            :disabled="loading"
            class="w-full"
          />
        </UFormField>

        <UButton type="submit" block :loading="loading" :disabled="loading"> Login </UButton>
      </form>

      <div class="mt-4 text-center">
        <NuxtLink to="/forgot-password" class="text-sm text-muted hover:text-default"> Forgot password? </NuxtLink>
      </div>
    </UCard>

    <div class="flex items-center gap-4 text-sm text-muted">
      <a
        href="https://github.com/piwitests/platform"
        target="_blank"
        rel="noopener"
        class="flex items-center gap-1.5 hover:text-default transition-colors"
      >
        <UIcon name="i-lucide-github" class="size-4" />
        GitHub
      </a>
      <span>·</span>
      <NuxtLink to="/docs" class="flex items-center gap-1.5 hover:text-default transition-colors">
        <UIcon name="i-lucide-book-open" class="size-4" />
        API Docs
      </NuxtLink>
    </div>
  </div>
</template>
