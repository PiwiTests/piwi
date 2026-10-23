<script setup lang="ts">
/**
 * The cluster's owner, made useful: who to hand the failure to, where the answer
 * came from (a `piwi:owner` annotation or the repository's CODEOWNERS), a copy
 * action, and a jump to every test that owner is responsible for. When the owner
 * is only derived from CODEOWNERS, a one-line hint says how to override it in the
 * spec.
 */
import { formatTestSearchTerm } from '#shared/test-search';

const props = defineProps<{
  owner: { name: string; source: 'annotation' | 'codeowners' } | null;
  /** Piwi project id — the owner link filters this project's test cases. */
  projectId?: number | null;
}>();

const { copy, copied } = useCopy();

const ownerLink = computed(() =>
  props.owner && props.projectId != null
    ? `/projects/${props.projectId}?tab=tests&q=${encodeURIComponent(formatTestSearchTerm('owner', props.owner.name))}`
    : null,
);
</script>

<template>
  <div class="space-y-1" data-tour="cluster-owner">
    <div class="flex items-center gap-1.5 text-xs">
      <UIcon name="i-lucide-users" class="size-3.5 shrink-0 text-gray-400" />
      <span class="text-gray-500">Owner</span>
      <HelpHint topic="cluster.owner" />
    </div>

    <div v-if="owner" class="flex items-center gap-1.5 flex-wrap">
      <NuxtLink
        v-if="ownerLink"
        :to="ownerLink"
        class="text-sm font-medium text-primary hover:underline break-all"
        title="Show every test this owner is responsible for"
      >
        {{ owner.name }}
      </NuxtLink>
      <span v-else class="text-sm font-medium break-all">{{ owner.name }}</span>
      <UBadge color="neutral" variant="subtle" size="xs">
        {{ owner.source === 'annotation' ? 'annotation' : 'CODEOWNERS' }}
      </UBadge>
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        :icon="copied ? 'i-lucide-check' : 'i-lucide-clipboard'"
        :title="copied ? 'Copied!' : 'Copy owner'"
        aria-label="Copy owner"
        @click="copy(owner.name)"
      />
    </div>
    <p v-else class="text-sm text-muted">
      No owner —
      <span class="text-xs">add a <code class="font-mono">piwi:owner</code> annotation or a CODEOWNERS entry.</span>
    </p>

    <p v-if="owner?.source === 'codeowners'" class="text-xs text-muted">
      Derived from CODEOWNERS. Override it per test with
      <code class="font-mono">test.info().annotations.push({ type: 'piwi:owner', description: '@team' })</code>.
    </p>
  </div>
</template>
