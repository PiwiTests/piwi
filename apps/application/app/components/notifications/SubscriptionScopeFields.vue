<script setup lang="ts">
/**
 * The branch and environment fields of a subscription form. The branch field
 * offers the names the project's runs reported, the environment field the
 * project's environments (every project's, for a subscription on every
 * project), and each accepts a typed one, where `*` matches any characters
 * (`release/*`). An empty field matches every branch or environment.
 */
import { withTypedValue } from '~/utils/text-format';

const branches = defineModel<string[]>('branches', { required: true });
const environments = defineModel<string[]>('environments', { required: true });

const props = defineProps<{
  /** The subscription's project; null for a subscription on every project. */
  projectId: number | null;
  /** Branch names the project's runs reported. */
  knownBranches?: string[];
}>();

const branchItems = computed(() => [...new Set([...(props.knownBranches ?? []), ...branches.value])]);

function addBranch(text: string) {
  branches.value = withTypedValue(branches.value, text);
}
</script>

<template>
  <div class="space-y-2">
    <UFormField label="Branches" size="xs">
      <UInputMenu
        v-model="branches"
        :items="branchItems"
        multiple
        create-item
        open-on-click
        placeholder="Any branch"
        size="xs"
        class="w-full"
        data-testid="subscription-branches"
        @create="addBranch"
      />
    </UFormField>
    <UFormField label="Environments" size="xs">
      <EnvironmentSelectorsInput
        v-model="environments"
        :project-id="projectId"
        size="xs"
        class="w-full"
        data-testid="subscription-environments"
      />
    </UFormField>
    <p class="text-xs text-muted">
      <code>*</code> matches any characters, as in <code>release/*</code>. An environment matches its key or an alias,
      ignoring case. Applies to run and cluster events.
    </p>
  </div>
</template>
