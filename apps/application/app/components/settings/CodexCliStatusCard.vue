<script setup lang="ts">
import type { CodexCliStatus } from '~~/types/api';
import type { HelpTopicKey } from '~/utils/help-content';
defineProps<{ help?: HelpTopicKey }>();

const status = ref<CodexCliStatus | null>(null);
const loading = ref(false);
async function refresh() {
  loading.value = true;
  try {
    status.value = await $fetch<CodexCliStatus>('/api/ai/codex-cli/status', { query: { refresh: true } });
  } finally {
    loading.value = false;
  }
}
onMounted(refresh);
</script>

<template>
  <div class="rounded-lg border border-default p-4 space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="font-medium inline-flex items-center gap-1">Codex (local) <HelpHint v-if="help" :topic="help" /></p>
      <UButton size="xs" color="neutral" variant="ghost" :loading="loading" @click="refresh">Recheck</UButton>
    </div>
    <p class="text-sm text-muted">
      Uses your local ChatGPT login. Sign in on this machine with <code>codex login</code>.
    </p>
    <p class="text-sm">{{ status ? (status.loggedIn ? 'Signed in with ChatGPT' : status.error) : 'Checking…' }}</p>
    <p v-if="status?.version" class="text-xs text-muted">{{ status.version }}</p>
    <p v-if="status?.usage.calls" class="text-xs text-muted">
      {{ status.usage.calls }} calls · {{ status.usage.inputTokens }} input tokens ·
      {{ status.usage.cacheReadInputTokens }} cached · {{ status.usage.outputTokens }} output tokens
    </p>
  </div>
</template>
