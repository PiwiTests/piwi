<script setup lang="ts">
// Where an MCP client's sign-in lands (the OAuth authorization code flow): the
// authorize endpoint stored the client's request and sent the browser here with
// its id, or with the reason it refused the request. The auth middleware signs
// the user in first and comes back here. Allowing sends the browser back to the
// client with a code; the client name is whatever the client registered, so the
// page also says where the answer goes, and which host published the client's
// metadata document when its client_id is one.
import type { AuthorizationRequestView, AuthorizationStartError } from '~~/server/utils/mcp-oauth';

definePageMeta({ layout: false });
useHead({ title: 'Connect an MCP client' });

/** Why the authorize endpoint refused a request. Nothing was sent to the client. */
const START_ERRORS: Record<AuthorizationStartError, string> = {
  read_only:
    'This instance is read-only for now, so no MCP client can connect to it. Nothing was sent to the client; connect it again once the instance is writable.',
  invalid_client:
    'This MCP client is not registered on this instance. Remove the server from your client and add it again: it registers on its own.',
  invalid_client_metadata:
    'The client is identified by a metadata document this instance could not use: it could not be fetched from a public address in time, or it does not describe the client fully. Nothing was sent to it; an administrator can turn client metadata documents off so the client registers instead, or connect it with an API key.',
  invalid_redirect_uri:
    'The client asked to return to an address it did not register, so nothing was sent to it. Remove the server from your client and add it again.',
  unsupported_response_type:
    'The client asked for a kind of authorization this instance does not offer. Nothing was sent to it; connect it with an API key instead.',
  invalid_request:
    'The client’s request is incomplete: this instance requires PKCE. Nothing was sent to it; update the client, or connect it with an API key.',
  invalid_target:
    'The client asked for access to a server other than this instance’s MCP endpoint. Nothing was sent to it; check the URL you gave it.',
};

const route = useRoute();
const requestId = computed(() => (typeof route.query.request === 'string' ? route.query.request : ''));
const requestPath = computed(() => `/api/oauth/authorizations/${encodeURIComponent(requestId.value)}`);
const leaving = ref(false);

const { request, loading, loadError, deciding, decideError, signedInAs, decide } = useConnectRequest({
  problem: () => {
    const startError = typeof route.query.error === 'string' ? route.query.error : '';
    if (startError) {
      return (
        START_ERRORS[startError as AuthorizationStartError] ?? 'The client sent a request this instance cannot answer.'
      );
    }
    return requestId.value ? null : 'This link has no request. Connect again from your MCP client.';
  },
  fetch: () => $fetch<AuthorizationRequestView>(requestPath.value),
  loadFailed: 'This authorization request could not be loaded.',
  answer: (allow) =>
    $fetch<{ status: 'approved' | 'denied'; redirectTo: string }>(`${requestPath.value}/decision`, {
      method: 'POST',
      body: { allow },
    }),
  answered: (current, reply) => ({ ...current, status: reply.status }),
});

async function answer(allow: boolean) {
  const reply = await decide(allow);
  if (!reply) return;
  leaving.value = true;
  window.location.assign(reply.redirectTo);
}

const returnsTo = computed(() => {
  const redirect = request.value?.redirect;
  if (!redirect) return '';
  if (redirect.kind === 'loopback') return 'An application on this computer';
  if (redirect.kind === 'app') return `The application that opens ${redirect.label}:// links`;
  return redirect.label;
});
</script>

<template>
  <ConnectRequestCard title="Connect an MCP client" shot="mcp-oauth-consent" :loading="loading" :error="loadError">
    <div v-if="request" class="space-y-5">
      <dl class="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-3 text-sm">
        <dt class="font-semibold text-highlighted">Client</dt>
        <dd class="min-w-0">
          <span class="text-highlighted break-words" data-testid="oauth-client">{{ request.clientName }}</span>
          <span class="block text-xs text-muted">The name the client gave itself</span>
          <span v-if="request.clientIdHost" class="block text-xs text-muted" data-testid="oauth-client-host">
            In a document published on {{ request.clientIdHost }}
          </span>
        </dd>
        <dt class="font-semibold text-highlighted">Returns to</dt>
        <dd class="text-highlighted break-words" data-testid="oauth-returns-to">{{ returnsTo }}</dd>
        <template v-if="signedInAs">
          <dt class="font-semibold text-highlighted">Account</dt>
          <dd class="text-highlighted break-words">{{ signedInAs }}</dd>
        </template>
      </dl>

      <template v-if="request.status === 'pending'">
        <p class="text-sm text-highlighted leading-relaxed">
          Allowing lets this client use the MCP server with your role and project access: the read tools, and the triage
          tools where your role allows them. The connection is listed with your API keys, named after the client, and
          you can revoke it there.
        </p>
        <p class="text-sm text-highlighted leading-relaxed">
          If you have not just added this Piwi instance to an AI assistant or an editor, deny: someone may have sent you
          this link to get access in your name.
        </p>
        <p
          v-if="request.clientIdHost && request.redirect.kind === 'loopback'"
          class="text-sm text-highlighted leading-relaxed"
          data-testid="oauth-loopback-warning"
        >
          The answer goes to a program on this computer, and any program can name this document: allow only if you
          started this connection yourself, just now.
        </p>
        <ConnectRequestButtons
          :deciding="deciding"
          :error="decideError"
          :allow-disabled="leaving"
          :deny-disabled="leaving"
          @decide="answer"
        />
      </template>

      <p v-else-if="request.status === 'approved' || request.status === 'consumed'" class="text-sm text-highlighted">
        Allowed. The client finishes connecting on its own; you can close this tab.
      </p>
      <p v-else-if="request.status === 'denied'" class="text-sm text-highlighted">
        Denied. The client was not connected; you can close this tab.
      </p>
      <p v-else class="text-sm text-highlighted">This request has expired. Connect again from your MCP client.</p>
    </div>
  </ConnectRequestCard>
</template>
