<script setup lang="ts">
/**
 * Settings → Source control: the instance-wide SCM token the features that
 * read or write a repository use, for every project that sets none of its own.
 */
</script>

<template>
  <CapabilityDeclinedGuard capability="scm" label="Source control">
    <div class="space-y-6" data-tour="source-control-page">
      <SourceControlTokenCard />
    </div>
  </CapabilityDeclinedGuard>
</template>
