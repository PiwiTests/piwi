<script setup lang="ts">
// Where a person lands after authorizing a per-user source control credential
// at its host (GitLab, Bitbucket): the server has saved their token, or says
// why it did not. Opened as a popup by the token form, it tells the page that
// opened it, through the opener or a channel of this site (a host's page may
// cut the link to the opener), and closes; opened in the tab itself, it says
// so and links back. It shows only the fixed sentence its reason names.
import { safeReturnPath } from '#shared/return-path';
import { AUTHORIZATION_FAILURES, type AuthorizationFailure } from '#shared/credentials';

definePageMeta({ layout: false });
useHead({ title: 'Authorization' });

/** The message the token form listens for, on this site's origin only, and the channel it also comes through. */
const MESSAGE_TYPE = 'piwi:credential-authorized';
const CHANNEL = 'piwi-credential-authorized';

const route = useRoute();
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const ok = computed(() => route.query.result === 'ok');
const credentialId = computed(() => Number(text(route.query.credential)) || null);
const reason = computed(() => text(route.query.reason));
const message = computed(() =>
  reason.value in AUTHORIZATION_FAILURES
    ? AUTHORIZATION_FAILURES[reason.value as AuthorizationFailure]
    : 'The authorization did not go through.',
);
const returnTo = computed(() => safeReturnPath(route.query.returnTo) ?? '/settings/account');
const told = ref(false);

onMounted(() => {
  const outcome = {
    type: MESSAGE_TYPE,
    credentialId: credentialId.value,
    ok: ok.value,
    message: ok.value ? null : message.value,
  };
  const opener = window.opener as Window | null;
  if (opener && !opener.closed) {
    opener.postMessage(outcome, window.location.origin);
    told.value = true;
  } else if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(outcome);
    channel.close();
  }
  // A popup closes; a tab the person navigated in themselves stays, with its link back.
  if (told.value || window.name === 'piwi-authorize') {
    told.value = true;
    window.close();
  }
});
</script>

<template>
  <ConnectRequestCard
    :title="ok ? 'Authorized' : 'Not authorized'"
    shot="credential-authorized"
    :loading="false"
    error=""
  >
    <div class="space-y-4" data-testid="credential-authorized">
      <p class="text-sm text-highlighted leading-relaxed">
        <template v-if="ok">Your token is saved: CI actions on this credential now run in your name.</template>
        <template v-else>{{ message }}</template>
      </p>
      <p v-if="told" class="text-sm text-muted">You can close this window.</p>
      <UButton v-else :to="returnTo" label="Back to Piwi" icon="i-lucide-arrow-left" />
    </div>
  </ConnectRequestCard>
</template>
