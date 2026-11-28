<script setup lang="ts">
/**
 * Lock affordance for a setting that is pinned by a `PIWI_*` environment
 * variable (env always wins → the UI field is read-only). A small lock icon
 * whose tooltip lists the overriding env var(s) with their descriptions.
 * Generalized from the per-field lock first used in the AI context-limits grid.
 *
 * Pass `envVars` to name the variable(s); omit them only when the field is
 * read-only for a non-env reason (rare — prefer naming the var). With
 * `setBy="operator"`, the value is the operator's (`/api/operator/limits`),
 * set in place of those variables, and the tooltip says so.
 */
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';
import { getEnvVarMeta } from '#shared/piwi-env-vars';

const props = withDefaults(
  defineProps<{
    /** Env var(s) backing this locked field, shown in the tooltip. */
    envVars?: PiwiEnvVarName[];
    /** Icon size preset. Default 'sm' (3.5). */
    size?: 'xs' | 'sm' | 'md';
    /** Who set the value: its environment variable(s), or the operator in their place. */
    setBy?: 'environment' | 'operator';
  }>(),
  { size: 'sm', setBy: 'environment' },
);

const sizeClass = computed(() => {
  switch (props.size) {
    case 'xs':
      return 'size-3';
    case 'md':
      return 'size-4';
    default:
      return 'size-3.5';
  }
});

const tooltip = computed(() => {
  if (props.setBy === 'operator') {
    const names = props.envVars?.length ? `, in place of ${props.envVars.join(', ')}` : '';
    return `Set by the operator: whoever runs this instance set it through its operator API${names}`;
  }
  if (!props.envVars?.length) return 'Managed by environment variable';
  const lines = props.envVars.map((v) => {
    const desc = getEnvVarMeta(v).description;
    return desc ? `${v} — ${desc}` : v;
  });
  if (lines.length === 1) return `Set via ${lines[0]}`;
  return ['Set via environment variables:', ...lines].join('\n');
});
</script>

<template>
  <UTooltip :text="tooltip" :ui="{ content: 'whitespace-pre-line max-w-sm' }">
    <UIcon name="i-lucide-lock" class="text-gray-400" :class="sizeClass" />
  </UTooltip>
</template>
