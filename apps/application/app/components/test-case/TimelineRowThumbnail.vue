<script setup lang="ts">
/** A row's page as a thumbnail in the failure timeline's list: a click opens the frames full screen there. */
defineProps<{
  src: string;
  /** The moment the thumbnail shows, as the timeline writes it. */
  time: string;
}>();
const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <button
    type="button"
    class="block overflow-hidden rounded border border-default bg-elevated cursor-zoom-in outline-none focus-visible:outline-2 focus-visible:outline-primary"
    :aria-label="`Open the page full screen, ${time}`"
    @click.stop="emit('open')"
  >
    <img :src="src" alt="" loading="lazy" class="block aspect-video w-full object-cover object-top" />
  </button>
</template>
