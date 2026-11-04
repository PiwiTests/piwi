<script setup lang="ts">
import type { ApiResponse } from '~~/types/api';

const route = useRoute();
const router = useRouter();
const toast = useToast();

const token = computed(() => route.query.token as string | undefined);
const isInvite = computed(() => route.query.mode === 'invite');
const password = ref('');
const confirmPassword = ref('');
const loading = ref(false);
const error = ref('');

async function submit() {
  error.value = '';
  if (!token.value) {
    error.value = 'Missing reset token';
    return;
  }
  if (password.value.length < 8) {
    error.value = 'Password must be at least 8 characters';
    return;
  }
  if (password.value !== confirmPassword.value) {
    error.value = 'Passwords do not match';
    return;
  }

  loading.value = true;
  try {
    const { username } = await $fetch<ApiResponse<typeof import('~~/server/api/auth/reset-password.post').default>>(
      '/api/auth/reset-password',
      { method: 'POST', body: { token: token.value, password: password.value } },
    );
    toast.add({ title: isInvite.value ? 'Account activated!' : 'Password reset!', color: 'success' });
    // The username goes to `/login` in the history entry's state, never in the URL.
    router.push({ path: '/login', state: { username } });
  } catch (err: unknown) {
    const msg =
      err && typeof err === 'object' && 'data' in err ? (err.data as { message?: string })?.message : undefined;
    error.value = msg || 'Invalid or expired link';
  } finally {
    loading.value = false;
  }
}

definePageMeta({ layout: false });
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-elevated/50">
    <UCard class="w-full max-w-md">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-lock" class="size-6" />
          <h1 class="text-2xl font-bold">{{ isInvite ? 'Set your password' : 'Reset your password' }}</h1>
        </div>
      </template>

      <UAlert v-if="!token" color="error" title="Invalid link" description="This link is missing or malformed." />

      <template v-else>
        <UAlert v-if="error" color="error" :title="error" variant="subtle" class="mb-4" />

        <form class="space-y-4" @submit.prevent="submit">
          <UFormField label="New password" name="password" required>
            <UInput
              v-model="password"
              type="password"
              placeholder="Min 8 characters"
              autocomplete="new-password"
              :disabled="loading"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Confirm password" name="confirmPassword" required>
            <UInput
              v-model="confirmPassword"
              type="password"
              placeholder="Repeat password"
              autocomplete="new-password"
              :disabled="loading"
              class="w-full"
            />
          </UFormField>
          <UButton type="submit" block :loading="loading">
            {{ isInvite ? 'Activate account' : 'Reset password' }}
          </UButton>
        </form>
      </template>

      <div class="mt-4 text-center">
        <NuxtLink to="/login" class="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
          Back to login
        </NuxtLink>
      </div>
    </UCard>
  </div>
</template>
