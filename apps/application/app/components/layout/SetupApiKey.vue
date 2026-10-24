<script setup lang="ts">
/**
 * Creates the reporter's API key in place, for the signed-in user, and shows it
 * once, as the line the CI secret takes. The key carries its owner's access;
 * Settings → Account lists and revokes it like any other.
 */
import type { CreateApiKeyResponse } from '~~/types/api';

const props = defineProps<{
  /** Names the key after the project it reports, so the keys list says what each one is for. */
  projectName: string;
}>();

const { authState } = useAuth();
const toast = useToast();

const creating = ref(false);
const createdKey = ref<string | null>(null);

const userId = computed(() => authState.value.user?.id ?? null);

async function create() {
  if (!userId.value || creating.value) return;
  creating.value = true;
  try {
    const result = await $fetch<CreateApiKeyResponse>(`/api/users/${userId.value}/api-keys`, {
      method: 'POST',
      body: { name: `Playwright reporter — ${props.projectName}`.slice(0, 100) },
    });
    createdKey.value = result.key;
  } catch (error: unknown) {
    const message =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({ title: 'Could not create the API key', description: message || 'An error occurred', color: 'error' });
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="space-y-2" data-shot="setup-api-key">
    <p class="text-sm font-semibold text-highlighted">API key</p>
    <template v-if="!createdKey">
      <p class="text-sm text-highlighted leading-relaxed">
        Authentication is on, so the reporter needs a key. It reads it from <code>PIWI_API_KEY</code>: a CI secret, or
        your shell for a local run.
      </p>
      <UButton
        v-if="userId"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="creating"
        data-testid="setup-create-api-key"
        @click="create"
      >
        Create a key for {{ projectName }}
      </UButton>
      <p v-else class="text-xs text-muted">Sign in to create one, or ask an administrator for a key.</p>
    </template>
    <template v-else>
      <p class="text-sm text-highlighted leading-relaxed">
        Copy it now: it is not shown again. Add it to your CI secrets as <code>PIWI_API_KEY</code>, and never commit it.
      </p>
      <CodeBlock :code="`PIWI_API_KEY=${createdKey}`" lang="text" filename="CI secret" />
      <p class="text-xs text-muted">
        Revoke it any time on
        <NuxtLink to="/settings/account" :class="SENTENCE_LINK_CLASS">Account</NuxtLink>.
      </p>
    </template>
  </div>
</template>
