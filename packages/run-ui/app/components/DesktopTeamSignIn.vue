<script setup lang="ts">
/**
 * Desktop shell only: the sign-in waiting on the team instance's page, which asks the person to allow the app with the
 * code shown here; **Open the page again**, and **Cancel**, which ends it.
 */
defineProps<{ appName: string }>();

const { connection, busy, openPage, disconnect } = useDesktopTeamConnection();
const { t } = useRunUiWords();
</script>

<template>
  <div class="space-y-3">
    <p class="leading-relaxed text-default">
      <RunUiText name="runui_connectionAllowWithCode">
        <template #app>
          <strong>{{ appName }}</strong>
        </template>
        <template #code>
          <code class="rounded-md bg-elevated px-2 py-0.5 font-mono font-semibold tracking-wider text-highlighted">{{
            connection.userCode
          }}</code>
        </template>
      </RunUiText>
    </p>
    <div class="flex flex-wrap gap-2">
      <UButton
        v-if="connection.verificationUrl"
        icon="i-lucide-external-link"
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
</template>
