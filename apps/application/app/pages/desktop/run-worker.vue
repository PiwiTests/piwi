<script setup lang="ts">
/**
 * Desktop shell only: one worker of a run in a window of its own, which the shell keeps above the others
 * (`desktop_open_worker_window`, from the worker's **Open in a window** in the Local runs tray): its test, where it
 * stands, its controls and its page live, as the tray shows them (`DesktopRunWorker`). The run is named by `?ref=` and
 * the worker by its lane, `?lane=` (Playwright's `parallelIndex`, which the worker replacing a failed one keeps). The
 * window holds the runs' hub stream itself (`useDesktopRunHub`) while its run goes on, present on the runs while it is
 * not hidden, and lets it go once the run ended; the hub plugin leaves it alone. A window of its own: no layout.
 */
import { testName } from '@piwitests/run-model/stop';
import { DESKTOP_APP_NAME } from '#shared/piwi-ecosystem';

definePageMeta({ layout: false });

const route = useRoute();
const runRef = String(route.query.ref ?? '');
const lane = Number(route.query.lane);

const hub = useDesktopRunHub();
const session = computed(() => hub.state.sessions[runRef]);
const worker = computed(() => session.value?.workers.find((w) => w.parallelIndex === lane));
/** The run ended: the stream listed the live runs without it, or let it go after holding it. */
const ended = ref(false);

useHead({
  title: computed(() => {
    const test = worker.value?.test;
    return test ? `${testName(test)} · ${DESKTOP_APP_NAME}` : DESKTOP_APP_NAME;
  }),
});

/** What the live region reads out: what a command answered. */
const announcement = ref('');
function announce(text: string) {
  announcement.value = '';
  requestAnimationFrame(() => {
    announcement.value = text;
  });
}

const visibility = useDocumentVisibility();
function letGo() {
  hub.present(false);
  hub.want(false);
}
onMounted(() => {
  hub.want(true);
  watch(visibility, (shown) => hub.present(!ended.value && shown === 'visible'), { immediate: true });
  watch(
    () => hub.state.listed && !session.value,
    (gone) => {
      if (!gone || ended.value) return;
      ended.value = true;
      letGo();
    },
    { immediate: true },
  );
});
onBeforeUnmount(letGo);
</script>

<template>
  <main class="min-h-dvh bg-default">
    <DesktopRunWorker v-if="session && worker" :session="session" :worker="worker" @announce="announce" />
    <p v-else-if="ended" class="p-4 text-sm text-muted">This run ended: close the window.</p>
    <p v-else-if="hub.state.listed" class="p-4 text-sm text-muted">This worker has no test running now.</p>
    <p v-else class="p-4 text-sm text-muted">Connecting to the run…</p>
    <p role="status" aria-live="polite" class="sr-only">{{ announcement }}</p>
  </main>
</template>
