<script setup lang="ts">
/**
 * A commit range as the Changes tab shows it: its two ends, the host's compare page when there is one, and the
 * `git log` command to copy.
 */
import type { CommitRange } from '#shared/utils/run-metadata';

defineProps<{ range: CommitRange }>();

const { copy, copied } = useCopy();
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2 text-sm font-mono">
      <UBadge color="success" variant="soft" size="sm">{{ range.fromShort }}</UBadge>
      <UIcon name="i-lucide-arrow-right" class="size-3 text-muted" />
      <UBadge color="error" variant="soft" size="sm">{{ range.toShort }}</UBadge>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <UButton
        v-if="range.compareUrl"
        :to="range.compareUrl"
        target="_blank"
        external
        icon="i-lucide-external-link"
        size="sm"
        variant="soft"
        color="primary"
        label="View commits"
      />
      <div class="flex items-center gap-1.5 flex-1 min-w-0">
        <code class="flex-1 text-xs bg-elevated px-3 py-1.5 rounded font-mono truncate select-all">{{
          range.gitCommand
        }}</code>
        <UButton
          :icon="copied ? 'i-lucide-check' : 'i-lucide-clipboard'"
          size="xs"
          color="neutral"
          variant="ghost"
          :title="copied ? 'Copied' : 'Copy git command'"
          @click="copy(range.gitCommand)"
        />
      </div>
    </div>
  </div>
</template>
