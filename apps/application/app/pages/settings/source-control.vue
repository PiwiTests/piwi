<script setup lang="ts">
/**
 * Settings → Source control: the instance's SCM credentials the features that
 * read or write a repository use, for every project that names none of its
 * own. The page stays open with the `scm` capability declined, so the
 * credentials can still be taken out.
 */
const { state, canDecide } = await useInstanceCapabilities();
const declined = computed(() => state('scm') === 'declined');
</script>

<template>
  <div class="space-y-6" data-tour="source-control-page">
    <p v-if="declined" class="text-sm text-muted max-sm:px-4">
      Source control is declined for this instance: no feature reads or writes a repository, and its credentials can
      still be taken out here.
      <NuxtLink v-if="canDecide" to="/settings/capabilities" :class="SENTENCE_LINK_CLASS">Reconsider</NuxtLink>
    </p>
    <SourceControlCredentialsCard />
  </div>
</template>
