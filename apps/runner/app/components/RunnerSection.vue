<script setup lang="ts">
/** A card of the settings: its icon and heading, a line under them when it has one, then its body. */
defineProps<{ icon: string; title: string; description?: string }>();
</script>

<template>
  <UCard :ui="{ header: 'px-4 py-3 sm:px-5', body: 'p-4 sm:p-5' }">
    <template #header>
      <div class="flex items-start gap-3">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <UIcon :name="icon" class="size-4" />
        </span>
        <div class="min-w-0 space-y-0.5">
          <h2 class="text-sm font-semibold text-highlighted">{{ title }}</h2>
          <p v-if="description" class="text-xs text-muted">{{ description }}</p>
        </div>
      </div>
    </template>
    <slot />
  </UCard>
</template>
