<script setup lang="ts">
/**
 * The offer to start the app when the person signs in, shown once the app has just connected to a team instance while
 * Start on login is off (`useStartOnLoginOffer`): **Start on login** turns it on, **Not now** drops the offer. Turned
 * on elsewhere (the settings, the tray), the offer ends too, as the shell announces it (`piwi:background-settings`).
 */
defineProps<{
  /** The app's name, in the sentence that makes the offer. */
  appName: string;
}>();

const { offered, busy, turnOn, dismiss } = useStartOnLoginOffer();
const { t } = useRunUiWords();

let unlisten: (() => void) | null = null;
onMounted(async () => {
  unlisten =
    (await tauriEvent()
      ?.listen<{ start_on_login?: boolean }>('piwi:background-settings', ({ payload }) => {
        if (payload.start_on_login) dismiss();
      })
      .catch(() => null)) ?? null;
});
onScopeDispose(() => unlisten?.());
</script>

<template>
  <div
    v-if="offered"
    class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-default bg-elevated/50 p-3 text-sm"
    data-testid="start-on-login-offer"
  >
    <p class="min-w-0 flex-1 basis-60 text-highlighted">{{ t('runui_startOnLoginOffer', { app: appName }) }}</p>
    <div class="flex shrink-0 flex-wrap gap-2">
      <UButton size="xs" icon="i-lucide-power" :loading="busy" @click="turnOn">{{
        t('runui_startOnLoginTurnOn')
      }}</UButton>
      <UButton size="xs" color="neutral" variant="ghost" @click="dismiss">{{ t('runui_startOnLoginNotNow') }}</UButton>
    </div>
  </div>
</template>
