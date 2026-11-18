<script setup lang="ts">
/**
 * What an environment filter with nothing picked reads: the default
 * environment, or every environment. Picking environments by hand overrides
 * it, so callers show it beside the environment select only while none is
 * picked. Attributes land on the select.
 */
import type { HelpTopicKey } from '~/utils/help-content';

defineOptions({ inheritAttrs: false });

const allEnvironments = defineModel<boolean>({ required: true });

defineProps<{
  /** Names the default environment in its option, where one is known. */
  defaultEnvironment?: string | null;
  help?: HelpTopicKey;
}>();
</script>

<template>
  <ScopePolicySelect
    v-model="allEnvironments"
    :default-label="defaultEnvironment ? `Default environment (${defaultEnvironment})` : 'Default environment'"
    all-label="All environments"
    icon="i-lucide-server"
    accessible-name="Environment policy"
    :help="help"
    v-bind="$attrs"
  />
</template>
