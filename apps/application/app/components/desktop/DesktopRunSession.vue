<script setup lang="ts">
/**
 * Desktop shell only: the workers of a run the shell started, live, as its hub (the bundled server) tells them, each
 * with its test and where it stands (`DesktopRunWorker`). `named` puts the run's name above them, for a run the Local
 * runs tray does not list itself (one another window of the app started).
 */
import type { HubSession } from '@piwitests/core/run-hub';
import { desktopRunName } from '~/utils/desktop-run-view';

const props = defineProps<{ session: HubSession; named?: boolean }>();
const emit = defineEmits<{ announce: [text: string] }>();

const workers = computed(() => [...props.session.workers].sort((a, b) => a.parallelIndex - b.parallelIndex));
</script>

<template>
  <div class="space-y-1.5" data-shot="desktop-run-session">
    <p v-if="named" class="text-sm font-semibold text-highlighted">{{ desktopRunName(session) }}</p>
    <p v-if="workers.length === 0" class="text-xs text-muted">Starting a worker…</p>
    <ul v-else class="space-y-1.5" :aria-label="`The workers of ${desktopRunName(session)}`">
      <DesktopRunWorker
        v-for="worker in workers"
        :key="worker.worker"
        :session="session"
        :worker="worker"
        :count="workers.length"
        @announce="emit('announce', $event)"
      />
    </ul>
  </div>
</template>
