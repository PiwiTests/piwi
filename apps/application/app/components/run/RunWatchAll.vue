<script setup lang="ts">
import { LIVE_VIEW_END_TEXT, liveWorkerKey, liveWorkerName, type LiveWorkerState } from '#shared/live-view';
import { stepLabel } from '@piwitests/core/step-analysis';
import type { LiveTile } from '~/composables/useLiveWatch';
import { CURRENT_ITEM_RING_CLASS } from '~/utils';
import { STATUS_PALETTE } from '~/utils/status-palette';
import type { AttentionSignal } from '~/utils/live-attention';
import { liveStepOf, type LiveStepsByWorker } from '~/utils/live-steps';
import type { LiveWatchState } from '~/utils/live-watch';
import type { TestCaseResult } from '~~/types/api';

/**
 * **Watch all**: a tile for each worker in the run's live view, its latest image one a second at most, the test it
 * runs, the step it is on and what its test needs attention for (a stop, a **Stuck?** mark). A click shows the worker
 * in the lane panel, from its running row when the page holds one. In the demo, which runs no browser, each running
 * lane's tile names its step alone.
 */
const props = defineProps<{
  /** The workers in the run's live view; in the demo, a stand-in of each running lane. */
  workers: LiveWorkerState[];
  tiles: Record<string, LiveTile>;
  steps: LiveStepsByWorker;
  /** The run's running rows, for the test each worker runs. */
  running: TestCaseResult[];
  signals: AttentionSignal[];
  /** The worker the lane panel shows. */
  focused: { shard: number | null; worker: number; slot?: number } | null;
  state: LiveWatchState;
  demo: boolean;
}>();
const emit = defineEmits<{ focus: [worker: LiveWorkerState, row: TestCaseResult | null]; retry: [] }>();

/** The workers in lane order, by shard. */
const ordered = computed(() =>
  [...props.workers].sort(
    (a, b) => (a.shard ?? 0) - (b.shard ?? 0) || (a.slot ?? a.worker) - (b.slot ?? b.worker) || a.worker - b.worker,
  ),
);

/** The running row of a worker: of its lane when it says it, else of its index. */
function rowOf(worker: LiveWorkerState): TestCaseResult | null {
  return (
    props.running.find(
      (row) =>
        (row.shardIndex ?? null) === worker.shard &&
        (worker.slot !== undefined ? row.parallelIndex === worker.slot : row.workerIndex === worker.worker),
    ) ?? null
  );
}

interface TileView {
  key: string;
  worker: LiveWorkerState;
  row: TestCaseResult | null;
  name: string;
  tile: LiveTile | null;
  test: string | null;
  step: string | null;
  mark: { text: string; class: string } | null;
  focused: boolean;
}

const MARK_CLASS = { stuck: STATUS_PALETTE.running.stuck!.text, stopped: 'text-highlighted' } as const;

/** What a lane's running test needs attention for: a stop, else a **Stuck?** mark. */
function markOf(worker: LiveWorkerState): TileView['mark'] {
  if (worker.slot === undefined) return null;
  const own = props.signals.filter((signal) => signal.lane.shard === worker.shard && signal.lane.slot === worker.slot);
  const stop = own.find((signal) => signal.reason === 'stopped');
  if (stop) return { text: stop.stop ?? 'Stopped', class: MARK_CLASS.stopped };
  if (own.some((signal) => signal.reason === 'stuck')) return { text: 'Stuck?', class: MARK_CLASS.stuck };
  return null;
}

const views = computed<TileView[]>(() =>
  ordered.value.map((worker) => {
    const key = liveWorkerKey(worker);
    const row = rowOf(worker);
    const tile = props.tiles[key] ?? null;
    const test = row?.title ?? tile?.test ?? null;
    const step = test
      ? liveStepOf(props.steps, { shard: worker.shard, worker: row?.workerIndex ?? worker.worker, test })
      : null;
    const focused =
      !!props.focused &&
      props.focused.shard === worker.shard &&
      (props.focused.slot !== undefined && worker.slot !== undefined
        ? props.focused.slot === worker.slot
        : props.focused.worker === worker.worker);
    return {
      key,
      worker,
      row,
      name: liveWorkerName(worker),
      tile,
      test,
      step: step ? stepLabel(step) : null,
      mark: markOf(worker),
      focused,
    };
  }),
);

/** What the watch says while it shows no image, in place of the grid's images. */
const stateText = computed(() => {
  const state = props.state;
  if (props.demo) {
    return 'The demo runs no browser: each tile names the step its worker is on, with no image, page events, text or filmstrip.';
  }
  if (state.kind === 'connecting' && state.again) return 'Opening the watch again…';
  if (state.kind !== 'closed') return null;
  if (state.reason) return LIVE_VIEW_END_TEXT[state.reason];
  if (state.status === 429) return 'As many pages as the run allows watch it now. Try again once one closes.';
  return 'The watch did not open, or was lost.';
});
const canRetry = computed(() => !props.demo && props.state.kind === 'closed' && props.state.reason !== 'run-ended');

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A tile's name as a button: what a click does, then what the tile shows in words. */
function tileLabel(view: TileView): string {
  const shows = [view.test, view.mark?.text, view.step, view.tile?.refused].filter(Boolean);
  return `Show ${view.name} in full${shows.length ? `: ${shows.join(', ')}` : ''}`;
}
</script>

<template>
  <section
    class="space-y-2 max-sm:px-4"
    aria-label="Every worker of the run"
    data-testid="watch-all"
    data-shot="watch-all"
  >
    <p v-if="stateText" class="flex flex-wrap items-center gap-2 text-xs text-muted" role="status">
      {{ stateText }}
      <UButton
        v-if="canRetry"
        size="xs"
        color="neutral"
        variant="outline"
        label="Watch again"
        data-testid="watch-all-retry"
        @click="emit('retry')"
      />
    </p>
    <p v-if="!views.length" class="text-xs text-muted">No worker of the run is in its live view now.</p>
    <!-- Its padding leaves room for the shown worker's ring inside the scrolling block. -->
    <ul class="grid grid-cols-2 gap-2 p-1 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
      <li v-for="view in views" :key="view.key" class="min-w-0">
        <component
          :is="demo ? 'div' : 'button'"
          :type="demo ? undefined : 'button'"
          class="group block w-full min-w-0 rounded-md border border-default bg-default p-1.5 text-left"
          :class="[
            view.focused ? CURRENT_ITEM_RING_CLASS : '',
            demo ? '' : 'hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary',
          ]"
          :aria-pressed="demo ? undefined : view.focused"
          :aria-label="demo ? undefined : tileLabel(view)"
          :data-worker="view.key"
          data-testid="watch-all-tile"
          @click="!demo && emit('focus', view.worker, view.row)"
        >
          <div class="relative aspect-[16/10] w-full overflow-hidden rounded bg-elevated">
            <img
              v-if="view.tile?.url"
              :src="view.tile.url"
              :alt="`The page ${view.name} is on`"
              class="size-full object-contain"
              :class="view.tile.refused ? 'opacity-40' : ''"
              data-testid="watch-all-image"
            />
            <p
              v-if="!view.tile?.url || view.tile.refused"
              class="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted"
            >
              {{ view.tile?.refused ?? (demo ? (view.step ?? 'Between two steps') : 'Waiting for its first image…') }}
            </p>
          </div>
          <div class="mt-1.5 flex min-w-0 items-baseline gap-2">
            <span class="shrink-0 text-xs font-semibold text-highlighted">{{ capitalized(view.name) }}</span>
            <span v-if="view.mark" class="truncate text-xs" :class="view.mark.class" data-testid="watch-all-mark">{{
              view.mark.text
            }}</span>
          </div>
          <p class="truncate text-xs text-muted" :title="view.test ?? undefined">
            {{ view.test ?? 'Between two tests' }}
          </p>
          <p v-if="view.step && !demo" class="truncate font-mono text-xs text-muted" :title="view.step">
            {{ view.step }}
          </p>
        </component>
      </li>
    </ul>
  </section>
</template>
