<script setup lang="ts">
// Where a person lands after authorizing a per-user source control credential
// at its host (GitLab, Bitbucket): the server has saved their token, or says
// why it did not. Opened as a popup by the token form, it tells the page that
// opened it and closes; opened in the tab itself, it says so and links back.
import { safeReturnPath } from '#shared/return-path';

definePageMeta({ layout: false });
useHead({ title: 'Authorization' });

/** The message the token form listens for, on this site's origin only. */
const MESSAGE_TYPE = 'piwi:credential-authorized';

const route = useRoute();
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const ok = computed(() => route.query.result === 'ok');
const credentialId = computed(() => Number(text(route.query.credential)) || null);
const message = computed(() => text(route.query.message) || 'The authorization did not go through.');
const returnTo = computed(() => safeReturnPath(route.query.returnTo) ?? '/settings/account');
const told = ref(false);

onMounted(() => {
  const opener = window.opener as Window | null;
  if (!opener || opener.closed) return;
  opener.postMessage(
    { type: MESSAGE_TYPE, credentialId: credentialId.value, ok: ok.value, message: ok.value ? null : message.value },
    window.location.origin,
  );
  told.value = true;
  window.close();
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
