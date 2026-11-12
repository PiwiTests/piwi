<script setup lang="ts">
/**
 * **Inspect** in the lane panel: the page of the worker's test at each of its calls, as a document. The worker sends
 * the DOM snapshot Playwright's trace takes before each call, at its action and after it while Inspect is open, and
 * the instance keeps them in memory and serves each page rendered, without a script (`app/utils/live-inspect.ts`).
 * The view opens on the latest call and follows each new one (**Follow the latest call**) until the reader chooses an
 * older call in the list or picks a locator; **Before**, **Action** and **After** show the call's page at that moment
 * when the worker sent it. **Pick a locator** opens the snapshot picker on the page shown, as for a stored trace.
 * Nothing is kept here but what the panel heard of each snapshot, until the view moves on to the next test.
 */
import type { SnapshotPhase } from '@piwitests/core/live-inspect';
import {
  SNAPSHOT_PHASES,
  inspectCalls,
  inspectPageUrl,
  shownMoment,
  type HeardSnapshot,
  type InspectMoment,
} from '~/utils/live-inspect';
import { SEGMENTED_SELECTED_CLASS, SELECTED_ROW_CLASS } from '~/utils';

const props = defineProps<{
  runId: number;
  /** The snapshots of the worker's page the watch heard of, of the test the panel shows. */
  heard: readonly HeardSnapshot[];
  /** Why the worker sends no page, when it said so. */
  refused: string | null;
  /** The id of the page's watch, which the address of each page carries; null while the watch is not open. */
  watchId: string | null;
  /** The view ended: the pages kept on the instance went with it. */
  ended: boolean;
}>();

const baseURL = (useRuntimeConfig().app.baseURL || '/').replace(/\/$/, '');

/** **Follow the latest call**: on by default, off once the reader chooses an older call or picks. */
const follow = ref(true);
/** The call the reader chose while the view does not follow, by its key. */
const pinned = ref<string | null>(null);
/** The moment the reader chose; null for each call's latest heard. */
const phase = ref<SnapshotPhase | null>(null);

const calls = computed(() => inspectCalls(props.heard));
const shown = computed(() => shownMoment(calls.value, follow.value ? null : pinned.value, phase.value));
const shownCall = computed(() =>
  shown.value ? calls.value.find((call) => call.call === shown.value!.call && sameWorker(call, shown.value!)) : null,
);
function sameWorker(a: { worker: InspectMoment['worker'] }, b: { worker: InspectMoment['worker'] }): boolean {
  return a.worker.shard === b.worker.shard && a.worker.worker === b.worker.worker;
}

watch(follow, (on) => {
  if (on) pinned.value = null;
  else pinned.value ??= shownCall.value?.key ?? null;
});

/** Show a call of the list: an older one stops the view following. */
function choose(key: string): void {
  if (follow.value && key === calls.value.at(-1)?.key) return;
  pinned.value = key;
  follow.value = false;
}

/** How long the view waits for the calls to settle before it loads the latest page, while it follows. */
const FOLLOW_SETTLE_MS = 300;
/** The moment whose page loads: the shown one, a moment later while the view follows. */
const loading = shallowRef<InspectMoment | null>(null);
let settle: ReturnType<typeof setTimeout> | null = null;
watch(
  shown,
  (next) => {
    if (settle) clearTimeout(settle);
    settle = null;
    const same =
      next && loading.value && next.call === loading.value.call && next.phase === loading.value.phase
        ? sameWorker(next, loading.value)
        : false;
    if (same) return;
    if (!next || !follow.value || !loading.value) {
      loading.value = next;
      return;
    }
    settle = setTimeout(() => {
      settle = null;
      loading.value = shown.value;
    }, FOLLOW_SETTLE_MS);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (settle) clearTimeout(settle);
});

/** The page loaded: its address and viewport, or why it does not show. */
const page = shallowRef<{
  moment: InspectMoment;
  src: string;
  viewport: { width: number; height: number } | null;
} | null>(null);
const pageError = ref<string | null>(null);
let asked = 0;
watch(
  [loading, () => props.watchId],
  async ([moment, watchId]) => {
    if (!moment || !watchId) return;
    const token = ++asked;
    try {
      const meta = await $fetch<{ viewport: { width: number; height: number } | null }>(
        inspectPageUrl(baseURL, props.runId, watchId, moment, 'json'),
      );
      if (token !== asked) return;
      page.value = {
        moment,
        src: inspectPageUrl(baseURL, props.runId, watchId, moment, 'readonly'),
        viewport: meta.viewport,
      };
      pageError.value = null;
    } catch (error) {
      if (token !== asked) return;
      page.value = null;
      pageError.value = errorMessage(error);
    }
  },
  { immediate: true },
);

const phaseWords = computed(() => SNAPSHOT_PHASES.find((p) => p.key === page.value?.moment.phase)?.words ?? '');

/** The picker on the page shown: a pick stops the view following. */
const picking = ref(false);
const pickerPage = shallowRef<{
  src: string;
  viewport: { width: number; height: number } | null;
  title: string;
} | null>(null);
function pick(): void {
  const shownPage = page.value;
  if (!shownPage || !props.watchId) return;
  pinned.value =
    calls.value.find((call) => call.call === shownPage.moment.call && sameWorker(call, shownPage.moment))?.key ?? null;
  follow.value = false;
  phase.value = shownPage.moment.phase;
  pickerPage.value = {
    src: inspectPageUrl(baseURL, props.runId, props.watchId, shownPage.moment, 'picker'),
    viewport: shownPage.viewport,
    title: shownPage.moment.title,
  };
  picking.value = true;
}

/** The list follows its latest call as one comes, while the view follows. */
const list = ref<HTMLElement | null>(null);
watch(
  () => calls.value.length,
  async () => {
    if (!follow.value) return;
    await nextTick();
    if (list.value) list.value.scrollTop = list.value.scrollHeight;
  },
);

/** What the view says while it shows no page. */
const waiting = computed(() => {
  if (props.ended) return 'The view ended: open the worker’s view again to inspect its page.';
  if (props.refused) return props.refused;
  if (!props.watchId) return 'Waiting for the view’s connection…';
  return 'Waiting for the page at the test’s next call. The worker sends one before each call, at its action and after it.';
});
</script>

<template>
  <div class="space-y-2" data-testid="live-inspect" data-shot="live-inspect">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <UCheckbox v-model="follow" label="Follow the latest call" size="sm" data-testid="live-inspect-follow" />
      <div
        role="group"
        aria-label="When the page was taken"
        class="inline-flex rounded-lg border border-default bg-elevated/40 p-0.5"
      >
        <button
          v-for="moment in SNAPSHOT_PHASES"
          :key="moment.key"
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          :class="shown?.phase === moment.key ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-highlighted'"
          :aria-pressed="shown?.phase === moment.key"
          :disabled="!shownCall?.phases.includes(moment.key)"
          :title="`The page ${moment.words}`"
          :data-testid="`live-inspect-${moment.key}`"
          @click="phase = moment.key"
        >
          {{ moment.label }}
        </button>
      </div>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        label="Pick a locator"
        :disabled="!page || ended"
        title="Click an element of this page to get the locators that target it"
        data-testid="live-inspect-pick"
        @click="pick"
      />
    </div>
    <p v-if="!calls.length || ended" class="text-xs text-muted" role="status" data-testid="live-inspect-waiting">
      {{ waiting }}
    </p>
    <template v-else>
      <p v-if="page" class="text-xs text-muted" data-testid="live-inspect-at">
        The page {{ phaseWords }}: <span class="font-mono">{{ page.moment.title }}</span>
      </p>
      <p v-if="pageError" class="text-xs text-muted" role="status" data-testid="live-inspect-error">{{ pageError }}</p>
      <DomSnapshotFrame
        v-else-if="page"
        :key="page.src"
        :frame-src="page.src"
        :viewport="page.viewport"
        :title="`The page ${phaseWords}: ${page.moment.title}`"
        stage-class="h-64 sm:h-80 @3xl:h-[30rem]"
        data-testid="live-inspect-frame"
      />
      <ol
        ref="list"
        class="max-h-40 divide-y divide-default overflow-y-auto rounded-md border border-default"
        aria-label="The calls whose page the worker sent, the latest last"
        data-testid="live-inspect-calls"
      >
        <li v-for="call in calls" :key="call.key">
          <button
            type="button"
            class="block w-full truncate px-2 py-1 text-left font-mono text-xs text-highlighted"
            :class="call.key === shownCall?.key ? SELECTED_ROW_CLASS : 'hover:bg-elevated'"
            :aria-current="call.key === shownCall?.key ? 'true' : undefined"
            :title="call.title"
            data-testid="live-inspect-call"
            @click="choose(call.key)"
          >
            {{ call.title }}
          </button>
        </li>
      </ol>
    </template>
    <p class="text-xs text-muted">
      The worker sends these pages only while Inspect is open, without their scripts and with the values of their secret
      fields removed. The instance keeps them in memory until the run ends.
    </p>
    <SnapshotLocatorPicker v-if="pickerPage" v-model:open="picking" :failing-locator="null" :live-page="pickerPage" />
  </div>
</template>
