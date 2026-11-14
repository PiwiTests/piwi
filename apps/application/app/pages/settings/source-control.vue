<script setup lang="ts">
/**
 * Settings → Source control: the instance-wide SCM token the features that
 * read or write a repository use, for every project that sets none of its own.
 * The page stays open with the `scm` capability declined, so a stored token
 * can still be removed.
 */
const { state, canDecide } = await useInstanceCapabilities();
const declined = computed(() => state('scm') === 'declined');
</script>

<template>
  <div class="space-y-6" data-tour="source-control-page">
    <p v-if="declined" class="text-sm text-muted max-sm:px-4">
      Source control is declined for this instance: no feature reads or writes a repository, and a stored token can
      still be removed here.
      <NuxtLink v-if="canDecide" to="/settings/capabilities" :class="SENTENCE_LINK_CLASS">Reconsider</NuxtLink>
    </p>
    <SourceControlTokenCard />
  </div>
</template>
