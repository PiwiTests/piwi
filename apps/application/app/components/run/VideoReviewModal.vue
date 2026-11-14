<script setup lang="ts">
/**
 * The large "Video review" dialog the test page's Evidence and the run's Video tab both open: the same wide modal on a
 * screen from `sm` up, and the whole screen below it. It holds the chrome only: the caller puts the mode switch in
 * `actions` and the reel in `body`, and keeps what they show.
 */
withDefaults(defineProps<{ title?: string; description?: string }>(), {
  title: 'Video review',
  description: undefined,
});
const open = defineModel<boolean>('open', { default: false });
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
    :ui="{
      content:
        'sm:w-[calc(100vw-4rem)] sm:max-w-6xl max-sm:inset-0 max-sm:translate-0 max-sm:w-screen max-sm:max-w-none max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none max-sm:ring-0',
      header: 'flex-wrap gap-x-4 gap-y-2 py-3 pe-14 sm:pe-16',
      wrapper: 'min-w-0 flex-1 basis-40',
      body: 'flex min-h-0 flex-col overflow-y-auto',
    }"
  >
    <template #actions>
      <slot name="actions" />
    </template>
    <template #body>
      <slot name="body" />
    </template>
  </UModal>
</template>
