<script setup lang="ts">
/**
 * The one Save of Settings → AI, kept in view at the bottom of the page: it
 * names the sections with unsaved changes and saves them all, or discards them.
 */
const form = useAiSettingsForm();
const changed = computed(() => form.changedSections.value);

const summary = computed(() => {
  const names = changed.value;
  if (!names.length) return 'No unsaved changes';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Unsaved changes in ${list}`;
});
</script>

<template>
  <div class="sticky bottom-3 z-10">
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-default bg-default/95 px-4 py-3 shadow-lg backdrop-blur max-sm:mx-3"
      role="region"
      aria-label="Save AI settings"
    >
      <div class="min-w-0 flex-1">
        <p class="text-sm text-highlighted" :class="changed.length ? 'font-semibold' : ''">{{ summary }}</p>
        <p v-if="form.saveError.value" class="text-xs text-error">{{ form.saveError.value }}</p>
      </div>
      <div class="flex items-center gap-2">
        <UButton
          v-if="changed.length"
          color="neutral"
          variant="ghost"
          :disabled="form.saving.value"
          @click="form.discard()"
        >
          Discard
        </UButton>
        <UButton
          color="primary"
          icon="i-lucide-save"
          :loading="form.saving.value"
          :disabled="!changed.length"
          data-tour="save-ai-providers"
          @click="form.save()"
        >
          Save
        </UButton>
      </div>
    </div>
  </div>
</template>
