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
/** The diagnosis test of this visit, shown only while the provider section holds what was saved. */
const test = computed(() => (form.providerChanged.value ? null : form.tests.diagnosis));

const sameUrl = (a: string | null, b: string | null) => (a ?? '').replace(/\/+$/, '') === (b ?? '').replace(/\/+$/, '');

/** A feature's model, with its provider when it is not the diagnosis one; `mono` when the value is a model id. */
function featureModel(role: AiRoleSettings | null): { value: string; mono: boolean } {
  if (!role) return { value: 'Off', mono: false };
  if (!role.model) {
    if (role.reuse) return { value: `The ${role.reuse === 'research' ? 'two-stage' : 'diagnosis'} model`, mono: false };
    return { value: `The default model of ${providerLabel(role.provider, role.baseUrl)}`, mono: false };
  }
  const own = !role.reuse && role.provider && main.value;
  const elsewhere = own && (role.provider !== main.value!.provider || !sameUrl(role.baseUrl, main.value!.baseUrl));
  return { value: elsewhere ? `${role.model}, ${providerLabel(role.provider, role.baseUrl)}` : role.model, mono: true };
}

const rows = computed(() => {
  const s = saved.value;
  if (!s) return [];
  return [
    { label: 'Auto-diagnose', value: s.autoDiagnose ? 'On' : 'Off', mono: false },
    { label: 'Two-stage diagnosis', ...featureModel(s.roles.research) },
    { label: 'Semantic clustering', ...featureModel(s.roles.embedding) },
    {
      label: 'Assistant model',
      ...(s.roles.assistant ? featureModel(s.roles.assistant) : { value: 'The diagnosis model', mono: false }),
    },
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
      <p v-if="test && (test.status === 'ok' || test.status === 'error')" class="mt-1 text-xs text-muted">
        {{ test.status === 'ok' ? 'Its connection test passed on this visit.' : 'Its last connection test failed.' }}
      </p>
      <dl class="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1">
        <template v-for="row in rows" :key="row.label">
          <dt class="text-xs text-muted">{{ row.label }}</dt>
          <dd class="text-xs text-highlighted" :class="row.mono ? 'font-mono' : ''">{{ row.value }}</dd>
        </template>
      </dl>
    </template>
  </section>
</template>
