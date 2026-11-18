<script setup lang="ts">
/**
 * Piwi Runner's connection to its team instance, in each of its states: the instance's address and Connect while it
 * has none (with the reason, once the instance disconnected it); the code to allow it on the instance's page while the
 * sign-in waits; once connected, where it stands, the instance to open, and Disconnect, which asks first. What it does
 * is the layer's (`useDesktopTeamConnection`).
 */
const { connection, connected, busy, openPage, connect, disconnect } = useDesktopTeamConnection();
const words = useRunUiWords();
const { t } = useRunnerWords();
const address = ref('');
const confirming = ref(false);

const host = computed(() => teamInstanceHost(connection.value.instance, words));

async function confirmDisconnect() {
  await disconnect();
  confirming.value = false;
}
</script>

<template>
  <div class="space-y-4 text-sm" data-testid="runner-connection-state">
    <div v-if="connection.state === 'signing-in'" class="space-y-3">
      <p class="leading-relaxed text-default">
        <RunUiText name="runui_connectionAllowWithCode">
          <template #app>
            <strong>Piwi Runner</strong>
          </template>
          <template #code>
            <code
              class="rounded-md bg-elevated px-2 py-0.5 font-mono text-base font-semibold tracking-wider text-highlighted"
              >{{ connection.userCode }}</code
            >
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
          >{{ words.t('runui_connectionOpenPageAgain') }}</UButton
        >
        <UButton color="neutral" variant="ghost" :loading="busy" @click="disconnect">{{
          words.t('runui_commonCancel')
        }}</UButton>
      </div>
    </div>

    <form
      v-else-if="!connected"
      method="post"
      class="flex flex-col gap-2 sm:flex-row"
      @submit.prevent="connect(address)"
    >
      <UInput
        v-model="address"
        type="url"
        size="lg"
        icon="i-lucide-globe"
        placeholder="https://piwi.example.com"
        class="flex-1"
        :aria-label="words.t('runui_connectionAddressLabel')"
      />
      <UButton type="submit" size="lg" :loading="busy" :disabled="!address.trim()">{{
        words.t('runui_connectionConnect')
      }}</UButton>
    </form>

    <template v-else>
      <div class="flex items-start gap-3">
        <span
          aria-hidden="true"
          :class="['mt-1.5 size-2.5 shrink-0 rounded-full', CONNECTION_STATE_DOTS[connection.state]]"
        />
        <div class="min-w-0 space-y-0.5">
          <p class="font-medium text-highlighted">{{ connectionStateWords(connection.state, words) }}</p>
          <code class="block text-xs break-all text-muted">{{ connection.instance }}</code>
        </div>
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-if="connection.instance"
          :to="connection.instance"
          target="_blank"
          size="sm"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-external-link"
          >{{ t('runner_openInstance', { host }) }}</UButton
        >
        <UPopover v-model:open="confirming">
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-unplug" data-testid="runner-disconnect">{{
            words.t('runui_connectionDisconnect')
          }}</UButton>
          <template #content>
            <div class="max-w-xs space-y-3 p-4" data-testid="runner-disconnect-question">
              <p class="text-sm font-semibold text-highlighted">{{ t('runner_disconnectQuestion', { host }) }}</p>
              <p class="text-xs text-muted">{{ t('runner_disconnectBody') }}</p>
              <div class="flex justify-end gap-2">
                <UButton size="sm" color="neutral" variant="ghost" @click="confirming = false">{{
                  words.t('runui_commonCancel')
                }}</UButton>
                <UButton size="sm" color="error" :loading="busy" @click="confirmDisconnect">{{
                  words.t('runui_connectionDisconnect')
                }}</UButton>
              </div>
            </div>
          </template>
        </UPopover>
      </div>
    </template>

    <p v-if="connection.error" class="text-xs text-error">{{ connectionErrorWords(connection, words) }}</p>
  </div>
</template>
