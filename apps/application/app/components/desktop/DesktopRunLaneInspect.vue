<script setup lang="ts">
/**
 * Desktop shell only: **Inspect** of a watched lane in the Local runs tray, under its page in its card: the page of
 * the lane's running test at each of its calls, which the app's server reads from the test's own trace on this machine
 * while the window has it open (`useDesktopRunHub().inspectOf`), shown as the run page's lane panel shows it
 * (`LaneInspect`), each page read rendered from the server through the window's stream (`desktopInspectSource`). Each
 * next test of the lane starts it afresh; between two tests it says the test ended.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { NO_DESKTOP_INSPECT, desktopInspectSource } from '~/utils/live-inspect';

const props = defineProps<{
  session: HubSession;
  worker: HubWorker;
}>();

const hub = useDesktopRunHub();
const base = (useRuntimeConfig().app.baseURL || '/').replace(/\/$/, '');
const runRef = computed(() => props.session.ref);
const lane = computed(() => props.worker.parallelIndex);
const inspect = computed(() => hub.inspectOf(runRef.value, lane.value) ?? NO_DESKTOP_INSPECT);
/** Where each page is read: the server, through the window's stream, while it is open. */
const source = computed(() => desktopInspectSource(base, hub.state.viewer, { ref: runRef.value, lane: lane.value }));
/** No test runs on the lane now: the server let the last one's pages go. */
const testEnded = computed(() => !props.worker.test);
</script>

<template>
  <LaneInspect
    class="border-t border-default px-2.5 py-2"
    :source="source"
    :heard="inspect.heard"
    :refused="inspect.refused"
    :turn="inspect.turn"
    :test-ended="testEnded"
    :ended="null"
    data-shot="desktop-run-inspect"
  />
</template>
