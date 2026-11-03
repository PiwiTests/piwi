<script setup lang="ts">
/**
 * Reset control for the demo banner: wipes the in-browser database and reloads
 * with fresh sample data dated to the current moment. Guarded by a small
 * confirmation popover since it discards any changes made this session.
 */
const { isResetting, resetDemo } = useDemoReset();
const confirmOpen = ref(false);

function confirmReset() {
  confirmOpen.value = false;
  resetDemo();
}
</script>

<template>
  <UPopover v-model:open="confirmOpen" :content="{ collisionPadding: 8 }" :ui="{ content: 'z-[70]' }">
    <!-- An icon alone on a phone, where the banner's controls share one row. -->
    <UButton
      size="xs"
      color="warning"
      variant="outline"
      icon="i-lucide-refresh-cw"
      aria-label="Reset data"
      title="Reset data"
      :loading="isResetting"
    >
      <span class="max-sm:hidden">Reset data</span>
    </UButton>

    <template #content>
      <div class="p-3 w-72 flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <p class="text-sm font-medium text-highlighted">Reset demo data?</p>
          <p class="text-xs text-muted">
            Wipes the in-browser database and reloads with fresh sample data dated to now. Any changes made this session
            will be lost.
          </p>
        </div>
        <div class="flex justify-end gap-2">
          <UButton size="xs" color="neutral" variant="ghost" label="Cancel" @click="confirmOpen = false" />
          <UButton
            size="xs"
            color="error"
            variant="solid"
            icon="i-lucide-refresh-cw"
            label="Reset"
            :loading="isResetting"
            @click="confirmReset"
          />
        </div>
      </div>
    </template>
  </UPopover>
</template>
