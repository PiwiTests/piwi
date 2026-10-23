<script setup lang="ts">
/**
 * The authored guides this user may start, one button each with its summary.
 * Picking one emits `start`, so the host closes what would cover the page,
 * then starts the guide.
 */
import type { AuthoredGuide } from '~/utils/guides/types';

const emit = defineEmits<{ start: [] }>();

const { guides, start } = await useAuthoredGuides();

function pick(guide: AuthoredGuide): void {
  emit('start');
  void start(guide);
}
</script>

<template>
  <div v-if="guides.length > 0" class="space-y-1.5" data-guide-list>
    <p class="text-sm font-semibold text-highlighted">Guides</p>
    <p class="text-xs text-muted">A walk through a task on your own screens, with no AI model.</p>
    <ul class="space-y-0.5">
      <li v-for="guide in guides" :key="guide.id">
        <button
          type="button"
          class="flex w-full items-start gap-2 rounded px-1 py-1.5 text-left hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
          :data-guide-id="guide.id"
          @click="pick(guide)"
        >
          <UIcon :name="guide.icon" class="size-4 mt-0.5 shrink-0 text-muted" />
          <span class="min-w-0">
            <span class="block text-sm text-highlighted">{{ guide.title }}</span>
            <span class="block text-xs text-muted">{{ guide.summary }}</span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>
