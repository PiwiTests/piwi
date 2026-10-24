<script setup lang="ts">
/**
 * Desktop build only: this app's URL and access token, for the runs the
 * reporter's discovery does not reach.
 *
 * The desktop app runs with auth off but the desktop guard enforces a local
 * access token on every request, so — unlike a no-auth server — the reporter
 * MUST send this token as its `apiKey`. It is a `pd_`-prefixed local secret.
 *
 * While the app runs it publishes that token and its URL to `~/.piwi/desktop.json`,
 * which the reporter reads on its own (the connect wizard above needs neither),
 * so these values are for another user account or a container.
 */
const props = defineProps<{
  /** Base server URL, e.g. `http://localhost:1234`. */
  url: string;
  /** The `pd_` access token enforced by the desktop guard. */
  token: string;
}>();

const { copy } = useCopy();

const manualSnippet = computed(
  () => `reporter: [
  ['@piwitests/reporter', {
    serverUrl: '${props.url}',
    projectName: 'my-project',
    apiKey: process.env.PIWI_API_KEY,
  }],
],`,
);
</script>

<template>
  <SectionCard icon="i-lucide-upload" title="Send results to this app">
    <template #subtitle>
      The reporter finds this app on its own while it runs, so the connect wizard above needs no URL and no token. These
      are for the runs it cannot reach: tests running as another user or in a container.
    </template>

    <div class="space-y-4 text-sm">
      <div class="space-y-3">
        <p class="text-muted">
          The token is a local secret: pass it as <code>PIWI_API_KEY</code> rather than committing it. A config that
          already sets a team server's <code>serverUrl</code> needs neither: <code>desktopApp: 'prefer'</code> sends its
          local runs here.
        </p>

        <div class="space-y-1">
          <div class="text-muted">Access token</div>
          <div class="flex items-start gap-2">
            <code class="text-xs break-all flex-1">{{ token }}</code>
            <UButton
              icon="i-lucide-copy"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="Copy access token"
              @click="copy(token, { toast: true })"
            />
          </div>
        </div>

        <CodeBlock :code="manualSnippet" lang="typescript" filename="playwright.config.ts" />
      </div>
    </div>
  </SectionCard>
</template>
