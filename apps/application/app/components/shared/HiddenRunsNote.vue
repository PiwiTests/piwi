<script setup lang="ts">
/**
 * The runs a Filters block hides, each count with the action that brings those
 * runs back, so a filter that is on by default never reads as missing data.
 * Renders nothing when the filters hide no run.
 */
withDefaults(
  defineProps<{
    /** Runs hidden by *Full runs only*. */
    partialRuns?: number;
    /** Runs hidden by the default-branch policy. */
    otherBranchRuns?: number;
    /** Runs hidden by the default-environment policy. */
    otherEnvironmentRuns?: number;
  }>(),
  { partialRuns: 0, otherBranchRuns: 0, otherEnvironmentRuns: 0 },
);

const emit = defineEmits<{ 'include-partial': []; 'all-branches': []; 'all-environments': [] }>();

const ACTION_CLASS = 'underline decoration-dotted underline-offset-2 hover:decoration-solid hover:text-highlighted';
</script>

<template>
  <p
    v-if="otherBranchRuns > 0 || partialRuns > 0 || otherEnvironmentRuns > 0"
    class="flex flex-wrap gap-x-4 gap-y-1"
    data-testid="hidden-runs"
  >
    <span v-if="otherEnvironmentRuns > 0">
      {{ hiddenRunsPhrase(otherEnvironmentRuns, 'other-environments') }} ·
      <button type="button" :class="ACTION_CLASS" @click="emit('all-environments')">Show all environments</button>
    </span>
    <span v-if="otherBranchRuns > 0">
      {{ hiddenRunsPhrase(otherBranchRuns, 'other-branches') }} ·
      <button type="button" :class="ACTION_CLASS" @click="emit('all-branches')">Show all branches</button>
    </span>
    <span v-if="partialRuns > 0">
      {{ hiddenRunsPhrase(partialRuns, 'partial') }} ·
      <button type="button" :class="ACTION_CLASS" @click="emit('include-partial')">Include partial runs</button>
    </span>
  </p>
</template>
