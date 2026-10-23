<script setup lang="ts">
/**
 * A suggested patch of an answer, with the badge its check against the files
 * at the run's commit earned, as on a diagnosis.
 */
import type { PatchValidation } from '#shared/patch';

defineProps<{ patch: string; validation: PatchValidation | null; title?: string }>();
</script>

<template>
  <div class="space-y-1.5 min-w-0">
    <p v-if="title" class="text-sm font-semibold text-highlighted">{{ title }}</p>
    <PatchBlock :patch="patch" :validation="validation" download-name="piwi-assistant-fix" />
  </div>
</template>
