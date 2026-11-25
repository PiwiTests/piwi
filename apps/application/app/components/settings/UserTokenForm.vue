<script setup lang="ts">
/**
 * The form where a person gives their own token for a per-user credential:
 * their user name on the CI server and an API token, tested before it is
 * saved. It says where the token goes and who set the credential up, so a
 * person knows whom they give it to. Serves the Account page and the run
 * dialog, which reads the credential's entry when only its id is given. A
 * source control credential takes an authorization at its host instead: a
 * popup to GitLab or Bitbucket, whose return page tells this one.
 */
import type { MyCredentialEntry } from '#shared/credentials';
import { SCM_PROVIDER_LABELS, scmDestinationHost } from '#shared/scm-urls';
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
const config = useRuntimeConfig();
const route = useRoute();
const oauth = computed(() => credential.value?.method === 'oauth');
/** How the host is named: Bitbucket for its API, else GitLab (the cloud or a listed host). */
const hostLabel = computed(() =>
  credential.value && scmDestinationHost(credential.value.destination) === 'bitbucket'
    ? SCM_PROVIDER_LABELS.bitbucket
    : SCM_PROVIDER_LABELS.gitlab,
);

/** The popup this form opened, while it waits for its answer. */
let popup: Window | null = null;
let watchingPopup: ReturnType<typeof setInterval> | null = null;
let channel: BroadcastChannel | null = null;

function stopWaiting() {
  popup = null;
  if (watchingPopup) clearInterval(watchingPopup);
  watchingPopup = null;
  saving.value = false;
}

/** The return page's answer, from this site only: for this credential, or one with none while this form's popup is open. */
function onAnswer(data: { type?: string; credentialId?: number | null; ok?: boolean; message?: string | null } | null) {
  if (data?.type !== 'piwi:credential-authorized') return;
  if (data.credentialId !== props.credentialId && !(data.credentialId == null && popup)) return;
  stopWaiting();
  if (data.ok) void reread();
  else error.value = data.message ?? 'The authorization did not go through.';
}
function onMessage(event: MessageEvent) {
  if (event.origin === window.location.origin) onAnswer(event.data);
}
onMounted(() => {
  window.addEventListener('message', onMessage);
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('piwi-credential-authorized');
    channel.onmessage = (event) => onAnswer(event.data);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  channel?.close();
  stopWaiting();
});

async function reread() {
  const mine = await $fetch<MineAnswer>('/api/credentials/mine');
  const entry = mine.items.find((item) => item.id === props.credentialId);
  if (entry?.token) emit('saved', entry);
}

/** Send the person to the host in a popup, or in this tab when popups are blocked. */
async function authorize() {
  error.value = null;
  if (!credential.value) return;
  // The demo talks to no host: its server takes the authorization as given.
  if (config.public.demoMode) {
    saving.value = true;
    try {
      const answer = await $fetch<SaveAnswer>(`/api/credentials/${props.credentialId}/token`, {
        method: 'PUT',
        body: {},
      });
      if (answer.credential) emit('saved', answer.credential);
    } catch (e) {
      error.value = errorMessage(e, 'The authorization did not go through.');
    } finally {
      saving.value = false;
    }
    return;
  }
  const url = `${config.app.baseURL.replace(/\/$/, '')}/api/credentials/${props.credentialId}/authorize?returnTo=${encodeURIComponent(route.fullPath)}`;
  popup = window.open(url, 'piwi-authorize', 'width=720,height=780');
  if (!popup) {
    window.location.assign(url);
    return;
  }
  saving.value = true;
  // A popup closed before it answered (the person closed it at the host) lets the button be pressed again.
  watchingPopup = setInterval(() => {
    if (popup?.closed) stopWaiting();
  }, 500);
}
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
  <div v-if="oauth" class="space-y-3" data-testid="user-token-authorize">
    <p v-if="loadError" class="text-sm text-error">This credential could not be read: reload the page.</p>
    <p v-else-if="credential" class="text-sm text-muted">
      {{ hostLabel }} asks you to authorize Piwi, then CI actions on this credential run as your
      {{ hostLabel }} account, with your rights<template v-if="credential.createdByName"
        >; set up by {{ credential.createdByName }}</template
      >. The token is encrypted and never shown again.
    </p>
    <p v-if="error" class="text-sm text-error" data-testid="user-token-error">{{ error }}</p>
    <UButton
      size="sm"
      icon="i-lucide-external-link"
      :label="`Authorize with ${hostLabel}`"
      :loading="saving"
      :disabled="!credential"
      data-testid="user-token-authorize-button"
      @click="authorize"
    />
  </div>
  <form v-else method="post" class="space-y-3" data-testid="user-token-form" @submit.prevent="save">
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
