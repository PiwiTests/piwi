<script setup lang="ts">
/**
 * Test a role's connection in Settings → AI and keep the answer in view: what
 * blocks the test, then whether the provider answered and with what error.
 * Any change to the connection clears the result (`useAiSettingsForm`).
 */
import type { AiModelRole } from '~~/types/api';
import { isLocalCliProvider } from '~/utils/ai-provider-catalog';

const props = withDefaults(defineProps<{ role: AiModelRole; label?: string }>(), { label: 'Test connection' });

const form = useAiSettingsForm();
const test = computed(() => form.tests[props.role]);
const cli = useLocalCliStatus();

/** What keeps the test from running: the form's own check, then a CLI not installed or not signed in. */
const blocker = computed(() => {
  const own = form.testBlocker(props.role);
  if (own) return own;
  const provider = form.resolvedProvider(props.role);
  if (!isLocalCliProvider(provider) || form.envManaged.value) return null;
  const v = cli.view(provider);
  if (v.checked && !v.installed) return 'Install it on this machine first.';
  if (v.checked && !v.ready) return provider === 'deepseek-cli' ? 'Add its credentials first.' : 'Sign in first.';
  return null;
});
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-plug"
        :loading="test.status === 'testing'"
        :disabled="Boolean(blocker)"
        data-tour="test-ai-connection"
        @click="form.testRole(role)"
      >
        {{ label }}
      </UButton>
      <span v-if="blocker" class="text-xs text-muted">{{ blocker }}</span>
    </div>
    <UAlert
      v-if="test.status === 'ok' || test.status === 'error'"
      role="status"
      variant="subtle"
      :color="test.status === 'ok' ? 'success' : 'error'"
      :icon="test.status === 'ok' ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
      :title="test.status === 'ok' ? test.message : 'The provider did not answer'"
      :description="test.status === 'error' ? test.message : undefined"
    />
  </div>
</template>
