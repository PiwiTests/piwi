<script setup lang="ts">
/**
 * The waiting rows above a project's runs: its CI dispatches no run has answered yet, and the viewer's own run
 * requests still going on, which only they see (`app/utils/waiting-runs.ts`). Read in the browser once the list
 * shows, again on each run event of the shared stream while a row shows, and on a timer while one shows
 * (`waitingRunsPollMs`), never while the tab is hidden. A dispatch sent from the page (`sent`) shows at once.
 */
import type { CiDispatchView } from '#shared/ci-dispatches';
import type { RunRequestView } from '#shared/handlers/run-requests';
import { safeHttpUrl } from '#shared/utils/safe-url';
import { WAITING_DISPATCHES_READ, WAITING_ROWS_SHOWN, waitingRunRows, waitingRunsPollMs } from '~/utils/waiting-runs';

const props = defineProps<{
  projectId: number;
  /** Read the project's CI dispatches: its CI actions are on. */
  dispatches: boolean;
  /** Read the viewer's own run requests: they may ask their apps for runs here. */
  requests: boolean;
  /** The last dispatch sent from the page. */
  sent?: CiDispatchView | null;
}>();

const openDispatches = ref<CiDispatchView[]>([]);
const ownRequests = ref<RunRequestView[]>([]);
/** The clock the rows read, so a dispatch that waited long says so. */
const now = ref(Date.now());
const rows = computed(() => waitingRunRows(openDispatches.value, ownRequests.value, now.value));
const showAll = useViewState('runs:waiting-all', () => false);
const shownRows = computed(() => (showAll.value ? rows.value : rows.value.slice(0, WAITING_ROWS_SHOWN)));

let timer: ReturnType<typeof setTimeout> | null = null;
let unmounted = false;
/** The latest read: an earlier one that answers after it is dropped. */
let reads = 0;

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule() {
  clearTimer();
  const wait = waitingRunsPollMs(rows.value);
  // A hidden tab stops reading; the shared stream reads again when it shows.
  if (wait != null && !unmounted) timer = setTimeout(() => (document.hidden ? clearTimer() : read()), wait);
}

async function read() {
  clearTimer();
  const current = ++reads;
  const [dispatches, requests] = await Promise.all([
    props.dispatches
      ? $fetch<{ items: CiDispatchView[] }>(`/api/projects/${props.projectId}/ci-dispatches`, {
          query: { state: 'open', limit: WAITING_DISPATCHES_READ },
        })
          .then((answer) => answer.items)
          .catch(() => null)
      : [],
    props.requests
      ? $fetch<{ items: RunRequestView[] }>('/api/run-requests', { query: { projectId: props.projectId } })
          .then((answer) => answer.items)
          .catch(() => null)
      : [],
  ]);
  if (unmounted || current !== reads) return;
  // A read that failed keeps the rows it had.
  if (dispatches) openDispatches.value = dispatches;
  if (requests) ownRequests.value = requests;
  now.value = Date.now();
  schedule();
}

onMounted(read);
onBeforeUnmount(() => {
  unmounted = true;
  clearTimer();
});
useRunStream(() => (rows.value.length > 0 ? read() : Promise.resolve()));
watch(() => [props.dispatches, props.requests], read);
watch(
  () => props.sent,
  (sent) => {
    if (!sent || openDispatches.value.some((d) => d.id === sent.id)) return;
    // A read begun before the dispatch would answer without it.
    reads++;
    openDispatches.value = [sent, ...openDispatches.value];
    now.value = Date.now();
    schedule();
  },
);

const ciLink = (url: string | null) => safeHttpUrl(url);
</script>

<template>
  <div v-if="rows.length" class="mb-3 space-y-2" data-testid="waiting-runs" data-shot="waiting-runs">
    <ul class="space-y-2">
      <li
        v-for="row in shownRows"
        :key="`${row.kind}-${row.id}`"
        class="flex items-start gap-2 rounded-lg border border-dashed border-default px-3 py-2"
        :data-testid="`waiting-${row.kind}`"
      >
        <span :class="['size-2.5 rounded-full mt-1.5 shrink-0', STATUS_PALETTE[row.status].bg]" aria-hidden="true" />
        <p class="min-w-0 flex-1 text-sm text-highlighted leading-relaxed break-words">
          <span :title="row.causes.length ? `Most likely: ${row.causes.join(' ')}` : undefined">{{ row.lead }}</span>
          <span class="text-xs text-muted">
            · {{ row.facts }} · {{ row.kind === 'dispatch' ? 'dispatched' : 'sent' }}
            <ClientOnly>
              <span :title="prettyDateFormat(row.at)">{{ formatRelativeTime(row.at) }}</span>
            </ClientOnly>
            <template v-if="row.by"> by {{ row.by }}</template>
            <template v-if="row.kind === 'request'"> · only you see it</template>
            <template v-if="ciLink(row.ciUrl)">
              ·
              <a :href="ciLink(row.ciUrl)!" target="_blank" rel="noopener noreferrer" :class="SENTENCE_LINK_CLASS"
                >Open in CI</a
              >
            </template>
            <template v-if="row.runId">
              ·
              <NuxtLink :to="`/test-runs/${row.runId}`" :class="SENTENCE_LINK_CLASS"
                >Open run #{{ row.runId }}</NuxtLink
              >
            </template>
          </span>
        </p>
      </li>
    </ul>
    <UButton
      v-if="rows.length > WAITING_ROWS_SHOWN"
      size="xs"
      color="neutral"
      variant="ghost"
      :label="showAll ? 'Show fewer' : `Show all ${rows.length}`"
      @click="showAll = !showAll"
    />
  </div>
</template>
