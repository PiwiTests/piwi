<script setup lang="ts">
/**
 * **Run on my machine**, the app taking run requests from one team instance. Connect starts the device flow there: the
 * person allows the app on the instance's page, and the shell keeps the key it gives in the OS keychain. While
 * connected, the folders linked to the instance's projects are listed here, each by the name the instance gives its
 * project (its id when it gives none); a request for a project with none asks for its folder in its confirmation.
 * Disconnecting removes the key from the keychain; it stays listed in the instance's Connected apps until it is revoked
 * there. Right after the sign-in, while Start on login is off, it offers to turn it on (`DesktopStartOnLoginOffer`). Its parts are shared with each host's own views (`DesktopTeamSignIn`, `DesktopTeamConnectForm`,
 * `DesktopTeamFolders`), and what they do is `useDesktopTeamConnection`'s.
 */
/** The app's name, as the instance's page asks the person to allow it. */
defineProps<{ appName: string }>();

const { connection, connected, busy, keeping, loadConnection, loadFolders, disconnect } = useDesktopTeamConnection();
const words = useRunUiWords();
const { t } = words;

onMounted(loadConnection);
watch(() => [connection.value.state, connection.value.linkedProjectIds.join(',')], loadFolders, { immediate: true });
</script>

<template>
  <div class="space-y-4 text-sm">
    <p class="text-muted">
      <RunUiText name="runui_connectionHowItWorks">
        <template #run>
          <strong>{{ t('runui_requestRun') }}</strong>
        </template>
      </RunUiText>
    </p>

    <div class="space-y-1">
      <div class="text-muted">{{ t('runui_connectionStatus') }}</div>
      <div class="flex items-start gap-2">
        <span
          aria-hidden="true"
          :class="['mt-1.5 size-2 shrink-0 rounded-full', CONNECTION_STATE_DOTS[connection.state]]"
          data-testid="team-instance-dot"
        />
        <div class="min-w-0 space-y-0.5">
          <div class="text-highlighted">{{ connectionStateWords(connection.state, words) }}</div>
          <code v-if="connection.instance && connection.state !== 'none'" class="block text-xs break-all">{{
            connection.instance
          }}</code>
        </div>
      </div>
      <p v-if="connection.error" class="text-xs text-error">{{ connectionErrorWords(connection, words) }}</p>
    </div>

    <DesktopTeamSignIn v-if="connection.state === 'signing-in'" :app-name="appName" />
    <DesktopTeamConnectForm v-else-if="!connected" />
    <template v-else>
      <DesktopStartOnLoginOffer :app-name="appName" />
      <div class="space-y-1">
        <div class="text-muted">{{ t('runui_connectionLinkedFolders') }}</div>
        <DesktopTeamFolders />
      </div>
      <UButton color="neutral" variant="outline" :loading="busy" :disabled="keeping" @click="disconnect">{{
        t('runui_connectionDisconnect')
      }}</UButton>
    </template>
  </div>
</template>
