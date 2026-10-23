<script setup lang="ts">
/** A page of the dashboard an answer points to, as a link button; a route outside the app shows as text. */
import { isAppRoute } from '~/utils/assistant/display';

defineProps<{ route: string; label: string }>();
</script>

<template>
  <div data-assistant-block="navigate">
    <UButton
      v-if="isAppRoute(route)"
      :to="route"
      size="sm"
      color="neutral"
      variant="outline"
      trailing-icon="i-lucide-arrow-right"
      :label="label"
    />
    <p v-else class="text-sm text-highlighted">{{ label }}</p>
  </div>
</template>
