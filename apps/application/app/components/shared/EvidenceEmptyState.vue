<script setup lang="ts">
/**
 * Renders the empty state of an evidence card as exactly one of three things —
 * *not captured*, *captured, nothing happened*, or *not applicable* — from the
 * decision made by `resolveEvidenceState`. A `present` state renders nothing:
 * the card shows its data instead.
 *
 * `not captured` and `not applicable` reuse `FeatureUnavailable` (the former
 * links to the connect wizard, the latter to the relevant doc); `nothing happened` is a
 * quiet confirmation that the fixtures ran and found nothing, so it gets no
 * call to action.
 */
import type { EvidenceState } from '#shared/evidence-state';

withDefaults(
  defineProps<{
    state: EvidenceState;
    /** Docs page for the setup instructions (defaults to the capture-fixtures guide). */
    doc?: string;
    /** Tighter layout for a folded card. */
    compact?: boolean;
  }>(),
  { doc: 'guide/capture-fixtures', compact: false },
);
</script>

<template>
  <FeatureUnavailable
    v-if="state.state === 'not-captured'"
    :title="state.title"
    :text="state.description"
    :to="state.to"
    :to-label="state.toLabel"
    :doc="doc"
    :compact="compact"
    :padded="!compact"
  />
  <FeatureUnavailable
    v-else-if="state.state === 'not-applicable'"
    :title="state.title"
    :text="state.description"
    to=""
    :doc="doc"
    icon="i-lucide-circle-slash"
    :compact="compact"
    :padded="!compact"
  />
  <div
    v-else-if="state.state === 'nothing-happened'"
    class="flex items-center gap-2 text-sm text-gray-500"
    :class="compact ? 'py-2' : 'justify-center py-6'"
  >
    <UIcon name="i-lucide-circle-check" class="size-4 opacity-60 shrink-0" />
    <span>{{ state.description }}</span>
  </div>
</template>
