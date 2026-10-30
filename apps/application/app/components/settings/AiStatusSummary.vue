<script setup lang="ts">
/**
 * The state of AI on this instance, at the top of Settings → AI, as saved: the
 * provider and model, the last connection test of this visit, and which
 * features are on with which model.
 */
import type { AiRoleSettings } from '~~/types/api';
import { providerLabel } from '~/utils/ai-provider-catalog';

const form = useAiSettingsForm();
const saved = computed(() => form.settings.value);
const main = computed(() => saved.value?.roles.diagnosis ?? null);
const test = computed(() => form.tests.diagnosis);

function featureModel(role: AiRoleSettings | null): string {
  if (!role) return 'Off';
  const model = role.model || 'the default model';
  if (role.reuse || !role.provider || role.provider === main.value?.provider) return model;
  return `${model}, ${providerLabel(role.provider, role.baseUrl)}`;
}

const rows = computed(() => {
  const s = saved.value;
  if (!s) return [];
  return [
    { label: 'Auto-diagnose', value: s.autoDiagnose ? 'On' : 'Off' },
    { label: 'Two-stage diagnosis', value: featureModel(s.roles.research) },
    { label: 'Semantic clustering', value: featureModel(s.roles.embedding) },
    { label: 'Assistant', value: s.roles.assistant ? featureModel(s.roles.assistant) : 'The diagnosis model' },
  ];
});
</script>

<template>
  <section
    class="rounded-lg border border-default p-4 max-sm:rounded-none max-sm:border-x-0"
    aria-label="AI status"
    data-tour="ai-status"
  >
    <template v-if="!main">
      <p class="text-sm font-semibold text-highlighted">AI is off</p>
      <p class="mt-1 text-sm text-highlighted leading-relaxed">
        Choose a provider below to turn on failure diagnosis. Nothing leaves this server until you do.
      </p>
    </template>
    <template v-else>
      <p class="text-sm font-semibold text-highlighted">AI diagnosis is on</p>
      <p class="mt-1 text-sm text-highlighted">
        {{ providerLabel(main.provider, main.baseUrl) }} ·
        <span class="font-mono">{{ main.model || 'the default model' }}</span>
        <template v-if="form.envManaged.value">, set by environment variables</template>
      </p>
      <p v-if="test.status === 'ok' || test.status === 'error'" class="mt-1 text-xs text-muted">
        {{ test.status === 'ok' ? 'Its connection test passed on this visit.' : 'Its last connection test failed.' }}
      </p>
      <dl class="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1">
        <template v-for="row in rows" :key="row.label">
          <dt class="text-xs text-muted">{{ row.label }}</dt>
          <dd class="font-mono text-xs text-highlighted">{{ row.value }}</dd>
        </template>
      </dl>
    </template>
  </section>
</template>
