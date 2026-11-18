<script setup lang="ts">
/** Desktop shell only: the team instance's address and **Connect**, which starts the device flow there. */
const { busy, connect } = useDesktopTeamConnection();
const { t } = useRunUiWords();
const address = ref('');
</script>

<template>
  <form method="post" class="flex flex-col gap-2 sm:flex-row" @submit.prevent="connect(address)">
    <UInput
      v-model="address"
      type="url"
      icon="i-lucide-globe"
      placeholder="https://piwi.example.com"
      class="flex-1"
      :aria-label="t('runui_connectionAddressLabel')"
    />
    <UButton type="submit" :loading="busy" :disabled="!address.trim()">{{ t('runui_connectionConnect') }}</UButton>
  </form>
</template>
