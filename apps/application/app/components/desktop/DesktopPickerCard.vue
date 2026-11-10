<script setup lang="ts">
/**
 * Desktop build only: pairing Piwi Picker with this app, so **Run with
 * Playwright** in its Replay can send a bug report's steps here. **Pair** in the
 * extension's settings asks this window to allow it (`DesktopPickerPairingModal`);
 * the address and token below are the way by hand, for an extension that cannot
 * reach this app's usual address. Every run it sends waits for a click here.
 */
defineProps<{
  /** Base server URL, e.g. `http://127.0.0.1:1234`. */
  url: string;
  /** The `pd_` access token enforced by the desktop guard. */
  token: string;
}>();

const { copy } = useCopy();
</script>

<template>
  <SectionCard icon="i-lucide-link" title="Pair with Piwi Picker">
    <template #subtitle>
      Let the browser extension ask this app to run a bug report with Playwright, in a project linked to its folder.
    </template>

    <div class="space-y-3 text-sm" data-shot="desktop-picker-card">
      <p class="text-muted">
        In Piwi Picker's settings, under <strong>Desktop app</strong>, click <strong>Pair</strong>: this window asks you
        to allow it, with the code the extension shows. A bug report it sends shows here first: nothing runs until you
        click <strong>Run with Playwright</strong>.
      </p>
      <p class="text-muted">
        To pair by hand instead, paste this address and token under <strong>Pair by hand</strong>.
      </p>
      <div class="space-y-1">
        <div class="text-muted">Address</div>
        <div class="flex items-start gap-2">
          <code class="text-xs break-all flex-1">{{ url }}</code>
          <UButton
            icon="i-lucide-copy"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Copy address"
            @click="copy(url, { toast: true })"
          />
        </div>
      </div>
      <div class="space-y-1">
        <div class="text-muted">Token</div>
        <div class="flex items-start gap-2">
          <code class="text-xs break-all flex-1">{{ token }}</code>
          <UButton
            icon="i-lucide-copy"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Copy token"
            @click="copy(token, { toast: true })"
          />
        </div>
      </div>
    </div>
  </SectionCard>
</template>
