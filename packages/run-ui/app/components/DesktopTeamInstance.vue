<script setup lang="ts">
/**
 * **Run on my machine**, the app taking run requests from one team instance. Connect starts the device flow there: the
 * person allows the app on the instance's page, and the shell keeps the key it gives in the OS keychain. While
 * connected, the folders linked to the instance's projects are listed here, each by the name the instance gives its
 * project (its id when it gives none); a request for a project with none asks for its folder in its confirmation.
 * Disconnecting removes the key from the keychain; it stays listed in the instance's Connected apps until it is revoked
 * there. What it does is `useDesktopTeamConnection`'s.
 */
/** The app's name, as the instance's page asks the person to allow it. */
defineProps<{ appName: string }>();

const { connection, connected, folders, busy, loadConnection, loadFolders, openPage, connect, disconnect, unlink } =
  useDesktopTeamConnection();
const words = useRunUiWords();
const { t } = words;
const instanceUrl = ref('');

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

    <div v-if="connection.state === 'signing-in'" class="space-y-2">
      <p class="text-muted">
        <RunUiText name="runui_connectionAllowWithCode">
          <template #app>
            <strong>{{ appName }}</strong>
          </template>
          <template #code>
            <code class="text-highlighted">{{ connection.userCode }}</code>
          </template>
        </RunUiText>
      </p>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-if="connection.verificationUrl"
          color="neutral"
          variant="outline"
          @click="openPage(connection.verificationUrl)"
          >{{ t('runui_connectionOpenPageAgain') }}</UButton
        >
        <UButton color="neutral" variant="ghost" :loading="busy" @click="disconnect">{{
          t('runui_commonCancel')
        }}</UButton>
      </div>
    </div>

    <form
      v-else-if="!connected"
      method="post"
      class="flex flex-col sm:flex-row gap-2"
      @submit.prevent="connect(instanceUrl)"
    >
      <UInput
        v-model="instanceUrl"
        type="url"
        placeholder="https://piwi.example.com"
        class="flex-1"
        :aria-label="t('runui_connectionAddressLabel')"
      />
      <UButton type="submit" :loading="busy" :disabled="!instanceUrl.trim()">{{
        t('runui_connectionConnect')
      }}</UButton>
    </form>

    <template v-else>
      <div class="space-y-1">
        <div class="text-muted">{{ t('runui_connectionLinkedFolders') }}</div>
        <p v-if="Object.keys(folders).length === 0" class="text-xs text-muted">
          {{ t('runui_connectionNoLinkedFolder') }}
        </p>
        <ul v-else class="divide-y divide-default rounded-md border border-default">
          <li v-for="(folder, projectId) in folders" :key="projectId" class="flex items-center gap-3 min-w-0 px-3 py-2">
            <UIcon name="i-lucide-folder" class="size-4 shrink-0 text-muted" />
            <div class="min-w-0 flex-1">
              <div class="text-xs font-medium text-highlighted">
                {{ connection.projectNames[Number(projectId)] || t('runui_connectionProject', { id: projectId }) }}
              </div>
              <code class="block text-xs text-muted break-all">{{ folder }}</code>
            </div>
            <UButton color="neutral" variant="ghost" size="xs" @click="unlink(String(projectId))">{{
              t('runui_connectionUnlink')
            }}</UButton>
          </li>
        </ul>
      </div>
      <UButton color="neutral" variant="outline" :loading="busy" @click="disconnect">{{
        t('runui_connectionDisconnect')
      }}</UButton>
    </template>
  </div>
</template>
