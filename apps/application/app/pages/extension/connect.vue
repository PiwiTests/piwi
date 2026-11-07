<script setup lang="ts">
// Where Piwi Picker, the VS Code extension, the JetBrains plugin or a run
// target (the desktop app, Piwi Runner) sends the user to allow a connection (an RFC 8628 device authorization): the client
// shows the same code and polls until the signed-in user answers. The auth
// middleware signs the user in first and comes back here. The link carries the
// code, so anyone can send one: Allow stays disabled until the user confirms
// their own client shows it (RFC 8628 §5.4).
import type { ConnectRequestView } from '~~/server/utils/extension-connect';

definePageMeta({ layout: false });
const PICKER = {
  grant: 'with your role and project access',
  title: 'Connect Piwi Picker',
  start: 'clicked Connect in Piwi Picker',
  keyName: 'this browser',
  confirm: 'My Piwi Picker shows this same code',
  client: 'Piwi Picker',
  tick: 'Tick the box once Piwi Picker shows this same code',
  again: 'Start again from Piwi Picker’s settings.',
};
const EDITOR = {
  grant: 'with your role and project access',
  title: 'Connect your editor',
  start: 'run Piwi: Connect in your editor',
  keyName: 'this editor',
  confirm: 'My editor shows this same code',
  client: 'Your editor',
  tick: 'Tick the box once your editor shows this same code',
  again: 'Start again from Piwi: Connect in your editor.',
};
/** A run target's key receives the run requests you make and reports their runs, and nothing else. */
function targetWords(app: string) {
  return {
    grant: 'that sees the tests you ask to run on any of your projects, and reports their results in your name',
    title: `Connect ${app}`,
    start: `clicked Connect in ${app}`,
    keyName: 'this computer',
    confirm: `My ${app} shows this same code`,
    client: app,
    tick: `Tick the box once ${app} shows this same code`,
    again: `Start again from ${app}.`,
  };
}
const WORDS = {
  picker: PICKER,
  editor: EDITOR,
  desktop: targetWords('Piwi Desktop'),
  runner: targetWords('Piwi Runner'),
};

const route = useRoute();
const config = useRuntimeConfig();

const code = computed(() => (typeof route.query.code === 'string' ? route.query.code : ''));
const codeConfirmed = ref(false);

const { request, loading, loadError, deciding, decideError, signedInAs, decide } = useConnectRequest({
  problem: () =>
    code.value
      ? null
      : 'This link has no code. Start again from Piwi Picker’s settings or Piwi: Connect in your editor.',
  fetch: () => $fetch<ConnectRequestView>('/api/extension/connect/request', { query: { code: code.value } }),
  loadFailed: 'This connection request could not be loaded.',
  answer: (allow, current) =>
    $fetch<{ status: ConnectRequestView['status'] }>('/api/extension/connect/decision', {
      method: 'POST',
      body: { userCode: current.userCode, allow },
    }),
  answered: (current, reply) => ({ ...current, status: reply.status }),
});

const words = computed(() => WORDS[request.value?.clientKind ?? 'picker'] ?? PICKER);

useHead({ title: () => words.value.title });
</script>

<template>
  <ConnectRequestCard :title="words.title" shot="extension-connect" :loading="loading" :error="loadError">
    <div v-if="request" class="space-y-5">
      <p
        class="text-lg sm:text-xl font-semibold text-highlighted font-mono tracking-widest text-center"
        data-testid="connect-code"
      >
        {{ request.userCode }}
      </p>
      <dl class="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-3 text-sm">
        <dt class="font-semibold text-highlighted">Client</dt>
        <dd class="text-highlighted" data-testid="connect-client">{{ request.clientName }}</dd>
        <template v-if="signedInAs">
          <dt class="font-semibold text-highlighted">Account</dt>
          <dd class="text-highlighted">{{ signedInAs }}</dd>
        </template>
      </dl>

      <template v-if="request.status === 'pending'">
        <p class="text-sm text-highlighted leading-relaxed">
          If you have not just {{ words.start }}, deny: someone may have sent you this link to get access in your name.
          <template v-if="config.public.authEnabled">
            Allowing creates an API key named after {{ words.keyName }}, {{ words.grant }}. You can revoke it in your
            account’s API keys.
          </template>
          <template v-else>
            Authentication is off on this instance, so no key is needed: allowing only confirms the connection.
          </template>
        </p>
        <UCheckbox v-model="codeConfirmed" :label="words.confirm" data-testid="connect-code-confirm" />
        <ConnectRequestButtons
          :deciding="deciding"
          :error="decideError"
          :allow-disabled="!codeConfirmed"
          :allow-title="words.tick"
          @decide="decide"
        />
      </template>

      <p v-else-if="request.status === 'approved' || request.status === 'consumed'" class="text-sm text-highlighted">
        Allowed. {{ words.client }} finishes connecting on its own; you can close this tab.
      </p>
      <p v-else-if="request.status === 'denied'" class="text-sm text-highlighted">
        Denied. {{ words.client }} was not connected.
      </p>
      <p v-else class="text-sm text-highlighted">This request has expired. {{ words.again }}</p>
    </div>
  </ConnectRequestCard>
</template>
