<script setup lang="ts">
/**
 * What a branch filter with nothing picked reads: the default branch, or every
 * branch. Picking branches by hand overrides it, so callers show it beside the
 * branch select only while none is picked. Attributes land on the select.
 */
import type { HelpTopicKey } from '~/utils/help-content';

defineOptions({ inheritAttrs: false });

const allBranches = defineModel<boolean>({ required: true });

defineProps<{
  /** Names the default branch in its option, where one project's is known. */
  defaultBranch?: string | null;
  help?: HelpTopicKey;
}>();
</script>

<template>
  <ScopePolicySelect
    v-model="allBranches"
    :default-label="defaultBranch ? `Default branch (${defaultBranch})` : 'Default branch'"
    all-label="All branches"
    icon="i-lucide-git-branch"
    accessible-name="Branch policy"
    :help="help"
    v-bind="$attrs"
  />
</template>
