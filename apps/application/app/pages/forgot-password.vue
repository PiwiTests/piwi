<script setup lang="ts">
const toast = useToast();
const email = ref('');
const loading = ref(false);
const sent = ref(false);

async function submit() {
  if (!email.value) return;
  loading.value = true;
  try {
    await $fetch('/api/auth/forgot-password', { method: 'POST', body: { email: email.value } });
    sent.value = true;
  } catch {
    toast.add({ title: 'Something went wrong', description: 'Please try again.', color: 'error' });
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
          <UIcon name="i-lucide-key-round" class="size-6" />
          <h1 class="text-2xl font-bold">Forgot password</h1>
        </div>
      </template>

      <template v-if="sent">
        <UAlert
          color="success"
          icon="i-lucide-mail-check"
          title="Check your email"
          description="If an account with that email exists, a reset link has been sent."
        />
        <div class="mt-4 text-center">
          <NuxtLink to="/login" class="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            Back to login
          </NuxtLink>
        </div>
      </template>

      <template v-else>
        <p class="text-sm text-gray-500 mb-4">
          Enter your email address and we'll send you a link to reset your password.
        </p>
        <form class="space-y-4" method="post" @submit.prevent="submit">
          <UFormField label="Email" name="email" required>
            <UInput
              v-model="email"
              type="email"
              placeholder="you@example.com"
              autocomplete="email"
              :disabled="loading"
              class="w-full"
            />
          </UFormField>
          <UButton type="submit" block :loading="loading">Send reset link</UButton>
        </form>
        <div class="mt-4 text-center">
          <NuxtLink to="/login" class="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            Back to login
          </NuxtLink>
        </div>
      </template>
    </UCard>
  </div>
</template>
