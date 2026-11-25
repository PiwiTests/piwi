<script setup lang="ts">
/**
 * The form where a person gives their own token for a per-user credential:
 * their user name on the CI server and an API token, tested before it is
 * saved. It says where the token goes and who set the credential up, so a
 * person knows whom they give it to. Serves the Account page and the run
 * dialog, which reads the credential's entry when only its id is given.
 */
import type { MyCredentialEntry } from '#shared/credentials';
import type { ApiResponse } from '~~/types/api';

type MineAnswer = ApiResponse<typeof import('~~/server/api/credentials/mine.get').default>;
type SaveAnswer = ApiResponse<typeof import('~~/server/api/credentials/[id]/token/index.put').default>;

const props = defineProps<{
  credentialId: number;
  /** The credential's entry, when the caller already read it. */
  entry?: MyCredentialEntry | null;
}>();
const emit = defineEmits<{ saved: [entry: MyCredentialEntry] }>();

const { authState } = useAuth();
const loaded = ref<MyCredentialEntry | null>(null);
const credential = computed(() => props.entry ?? loaded.value);

const loadError = ref(false);
watch(
  () => [props.credentialId, props.entry] as const,
  async () => {
    // Another credential's destination is never shown while this one's is read.
    loaded.value = null;
    loadError.value = false;
    if (props.entry) return;
    const id = props.credentialId;
    try {
      const mine = await $fetch<MineAnswer>('/api/credentials/mine');
      if (id !== props.credentialId) return;
      loaded.value = mine.items.find((item) => item.id === id) ?? null;
      loadError.value = loaded.value === null;
    } catch {
      if (id === props.credentialId) loadError.value = true;
    }
  },
  { immediate: true },
);

const user = ref(authState.value.user?.username ?? '');
const secret = ref('');
const saving = ref(false);
const error = ref<string | null>(null);

async function save() {
  error.value = null;
  // A token is given only once the form says where it goes.
  if (!credential.value) return;
  if (!user.value.trim() || !secret.value.trim()) {
    error.value = 'Give your user name and an API token.';
    return;
  }
  saving.value = true;
  try {
    const answer = await $fetch<SaveAnswer>(`/api/credentials/${props.credentialId}/token`, {
      method: 'PUT',
      body: { user: user.value.trim(), secret: secret.value.trim() },
    });
    secret.value = '';
    if (answer.credential) emit('saved', answer.credential);
  } catch (e) {
    error.value = errorMessage(e, 'The token could not be saved.');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form method="post" class="space-y-3" data-testid="user-token-form" @submit.prevent="save">
    <p v-if="loadError" class="text-sm text-error">This credential could not be read: reload the page.</p>
    <p v-else-if="credential" class="text-sm text-muted">
      Your token is sent only to <code class="font-mono break-all">{{ credential.destination }}</code
      ><template v-if="credential.createdByName">, set up by {{ credential.createdByName }}</template
      >. It is tested before it is saved, then encrypted and never shown again.
      <template v-if="credential.tokenHelpUrl">
        <a
          :href="credential.tokenHelpUrl"
          target="_blank"
          rel="noopener"
          class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >Create an API token</a
        >.
      </template>
    </p>
    <div class="grid gap-3 sm:grid-cols-2">
      <UFormField label="User name" name="userTokenUser">
        <UInput
          v-model="user"
          autocomplete="username"
          aria-label="Your user name on the CI server"
          class="w-full font-mono"
          data-testid="user-token-user"
        />
      </UFormField>
      <UFormField label="API token" name="userTokenSecret">
        <UInput
          v-model="secret"
          type="password"
          autocomplete="new-password"
          placeholder="Not your password"
          aria-label="Your API token on the CI server"
          class="w-full font-mono"
          data-testid="user-token-secret"
        />
      </UFormField>
    </div>
    <p v-if="error" class="text-sm text-error" data-testid="user-token-error">{{ error }}</p>
    <UButton
      type="submit"
      size="sm"
      icon="i-lucide-plug-zap"
      label="Test and save"
      :loading="saving"
      :disabled="!credential"
      data-testid="user-token-save"
    />
  </form>
</template>
