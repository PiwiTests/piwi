<script setup lang="ts">
import type { ApiResponse } from '~~/types/api';
import type { LiveAskView } from '#shared/live-view';
import type { RunLiveViewReadiness } from '~/utils/run-live-view-status';
import { askToWatchView, runLiveViewStatus } from '~/utils/run-live-view-status';

const props = defineProps<{
  readiness: RunLiveViewReadiness;
  projectId: number;
  runId: number;
}>();
const emit = defineEmits<{ retry: [] }>();
const { can } = useAuth();
const toast = useToast();
const { saving: turningOn, save } = useProjectPatch(() => props.projectId);
/**
 * Whether the project's live view was turned on from this page, which a run that started without it does not get:
 * the status reads it on until the run's stream says so, and off again once the stream says someone turned it off.
 */
const turnedOn = ref(false);
let heardOn = false;
watch(
  () => props.readiness.state?.enabled,
  (enabled) => {
    if (!turnedOn.value) return;
    if (enabled) heardOn = true;
    else if (heardOn) turnedOn.value = heardOn = false;
  },
);
const status = computed(() => {
  const state = props.readiness.state;
  const shown = turnedOn.value && state && !state.enabled ? { ...state, enabled: true } : state;
  return runLiveViewStatus({ ...props.readiness, state: shown, turnedOn: turnedOn.value });
});
/** A run that holds a key gets its own view back as the live view turns on; one without gets none. */
const turnOnLabel = computed(() =>
  props.readiness.state?.keyed ? 'Turn the live view on again' : 'Turn the live view on for the next runs',
);

/** A Project admin turns the project's live view on from here. */
async function turnOn(): Promise<void> {
  if (await save({ liveView: true }, 'Live view turned on')) turnedOn.value = true;
}

/**
 * The viewer's latest ask to watch the run, and when this page received it, as the run's stream or the ask's own
 * answer last gave it: its `waitMs` counts from then.
 */
const latestAsk = ref<{ view: LiveAskView; receivedAt: number } | null>(null);
/** When the instance said this viewer may ask again, after it refused an ask as too soon. */
const refusedUntil = ref<number | null>(null);
watch(
  () => props.readiness.state?.ask,
  (view, before) => {
    if (view === undefined) return;
    latestAsk.value = view ? { view, receivedAt: Date.now() } : null;
    // The developer shared the run this viewer asked about: its live view now shows.
    if (view?.answer === 'shared' && before?.id === view.id && before.answer === null) {
      toast.add({ title: 'The run is shared live', description: 'Its running tests offer Watch.', color: 'success' });
    }
  },
  { immediate: true },
);
const tick = useTimestamp({ scheduler: (update) => useIntervalFn(update, 15_000) });
/** When this page last heard of the viewer's ask, or of a refusal: the wait counts from no earlier than then. */
const heardAt = ref(0);
watch([latestAsk, refusedUntil], () => (heardAt.value = Date.now()));
const askView = computed(() => {
  const ask = latestAsk.value;
  const fromAsk = ask ? ask.receivedAt + ask.view.waitMs : null;
  const askAgainAt = Math.max(fromAsk ?? 0, refusedUntil.value ?? 0) || null;
  return askToWatchView({
    status: status.value.kind,
    canAsk: props.readiness.state?.canAsk === true,
    ask: ask?.view ?? null,
    askAgainAt,
    now: Math.max(tick.value, heardAt.value),
  });
});

const asking = ref(false);
/** Ask the developer to share the run: the instance hands the ask to the run, and its answer comes on the stream. */
async function ask(): Promise<void> {
  if (asking.value) return;
  asking.value = true;
  try {
    const view = await $fetch<ApiResponse<typeof import('~~/server/api/test-runs/[id]/live-view/ask.post').default>>(
      `/api/test-runs/${props.runId}/live-view/ask`,
      { method: 'POST' },
    );
    latestAsk.value = { view, receivedAt: Date.now() };
    refusedUntil.value = null;
  } catch (e) {
    const waitMs = (e as { data?: { data?: { waitMs?: unknown } } }).data?.data?.waitMs;
    if (typeof waitMs === 'number') refusedUntil.value = Date.now() + waitMs;
    toast.add({ title: 'Could not ask to watch', description: errorMessage(e), color: 'error' });
  } finally {
    asking.value = false;
  }
}
</script>

<template>
  <div
    class="inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted max-sm:px-4"
    data-shot="run-live-view-status"
    data-testid="live-view-readiness"
    :data-state="status.kind"
  >
    <span role="status" aria-live="polite">{{ status.label }}</span>
    <template v-if="status.kind === 'stalled'">
      <UButton size="xs" color="neutral" variant="link" class="p-0" @click="emit('retry')">Retry</UButton>
      <HelpHint topic="run.live-stalled" />
    </template>
    <HelpHint v-else-if="status.kind === 'desktop'" topic="run.live-desktop" />
    <HelpHint v-else-if="status.kind === 'demo'" topic="run.live-view-demo" />
    <HelpHint v-else-if="status.kind === 'unshared'" topic="run.live-unshared" />
    <HelpHint v-else-if="status.kind === 'no-workers'" topic="run.live-no-workers" />
    <HelpHint v-else topic="run.live-view-setup">
      <template #actions>
        <UButton
          v-if="status.kind === 'disabled' && can('project:manage', projectId)"
          size="xs"
          color="neutral"
          variant="link"
          class="justify-start p-0"
          :loading="turningOn"
          data-testid="live-view-turn-on"
          @click="turnOn"
        >
          {{ turnOnLabel }}
        </UButton>
        <UButton
          v-if="status.kind === 'disabled' && can('project:manage', projectId)"
          :to="`/projects/${projectId}?tab=settings&section=live-view`"
          size="xs"
          color="neutral"
          variant="link"
          class="justify-start p-0"
        >
          Open live-view settings
        </UButton>
      </template>
    </HelpHint>
    <!-- Ask to watch: what came of the viewer's ask, then the button, or the wait before they may ask again. -->
    <template v-if="askView">
      <span
        v-if="askView.note"
        role="status"
        aria-live="polite"
        data-testid="ask-to-watch-state"
        :data-state="askView.note"
        :title="
          askView.note === 'asked'
            ? 'The developer is asked where they launched the run: this page shows their answer.'
            : undefined
        "
      >
        · {{ askView.note === 'asked' ? 'Asked to watch' : 'The developer answered Not now' }}
      </span>
      <UButton
        v-if="askView.action"
        size="xs"
        color="neutral"
        variant="outline"
        :loading="asking"
        title="Ask the developer who runs it to share this run live, naming you"
        data-testid="ask-to-watch"
        @click="ask"
      >
        {{ askView.action === 'ask' ? 'Ask to watch' : 'Ask again' }}
      </UButton>
      <span v-else-if="askView.waitMinutes" data-testid="ask-to-watch-wait">
        · Ask again in {{ askView.waitMinutes }} min
      </span>
    </template>
  </div>
</template>
