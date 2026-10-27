<script setup lang="ts">
import type { CodexCliStatus } from '~~/types/api';
import type { HelpTopicKey } from '~/utils/help-content';
const props = defineProps<{ provider: 'codex-cli' | 'deepseek-cli'; help?: HelpTopicKey }>();
const deepseek = computed(() => props.provider === 'deepseek-cli');
const title = computed(() => (deepseek.value ? 'DeepSeek Harness (local)' : 'Codex (local)'));

const status = ref<CodexCliStatus | null>(null);
const loading = ref(false);
async function refresh() {
  loading.value = true;
  try {
    status.value = await $fetch<CodexCliStatus>(`/api/ai/${props.provider}/status`, { query: { refresh: true } });
  } finally {
    loading.value = false;
  }
}
onMounted(refresh);
</script>

<template>
  <div class="rounded-lg border border-default p-4 space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="font-medium inline-flex items-center gap-1">{{ title }} <HelpHint v-if="help" :topic="help" /></p>
      <UButton size="xs" color="neutral" variant="ghost" :loading="loading" @click="refresh">Recheck</UButton>
    </div>
    <p class="text-sm text-muted">
      <template v-if="deepseek"
        >Uses official <code>dsh</code> with your saved DeepSeek account or API key. Sign in through DeepSeek Harness on
        this machine.</template
      >
      <template v-else>Uses your local ChatGPT login. Sign in on this machine with <code>codex login</code>.</template>
    </p>
    <p class="text-sm">
      {{
        status
          ? status.loggedIn
            ? deepseek
              ? 'DeepSeek credentials configured (checked on use)'
              : 'Signed in with ChatGPT'
            : status.error
          : 'Checking…'
      }}
    </p>
    <p v-if="status?.version" class="text-xs text-muted">{{ status.version }}</p>
    <p v-if="status?.usage.calls" class="text-xs text-muted">
      {{ status.usage.calls }} calls · {{ status.usage.inputTokens }} input tokens ·
      {{ status.usage.cacheReadInputTokens }} cached · {{ status.usage.outputTokens }} output tokens
    </p>
  </div>
</template>
