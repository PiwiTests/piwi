<script setup lang="ts">
/**
 * The live view of one worker of a running run: the images of its test's page the worker sends while this view is
 * open, a few a second, each with the call it was taken at. Watching only: nothing here reaches the test. The view
 * ends as the test ends, the worker leaves, the run ends or the project turns its live view off, and as it closes.
 * Nothing is kept: the latest image alone is in this page's memory, until the view closes.
 */
import { LIVE_VIEW_END_TEXT, parseLiveViewerMessage, type LiveCall } from '#shared/live-view';

const props = defineProps<{ runId: number; worker: number; shard: number | null; test: string }>();
const open = defineModel<boolean>('open', { required: true });

const WAITING = 'Waiting for the first image of the page…';
const UNAVAILABLE =
  'This worker’s live view is not available now: its test may have ended, or as many people as a run allows watch it.';

const image = ref<string | null>(null);
const call = ref<LiveCall | null>(null);
const notice = ref(WAITING);
const ended = ref(false);
let source: EventSource | null = null;

const baseURL = useRuntimeConfig().app.baseURL;

function connect(): void {
  disconnect();
  image.value = null;
  call.value = null;
  notice.value = WAITING;
  ended.value = false;
  const query = new URLSearchParams({ worker: String(props.worker) });
  if (props.shard !== null) query.set('shard', String(props.shard));
  source = new EventSource(`${baseURL.replace(/\/$/, '')}/api/test-runs/${props.runId}/live-view/watch?${query}`);
  source.onmessage = (event) => {
    const message = parseLiveViewerMessage(String(event.data));
    if (!message) return;
    if (message.type === 'frame') {
      image.value = `data:image/jpeg;base64,${message.data}`;
      call.value = message.call;
      notice.value = '';
    } else if (message.type === 'refused') {
      notice.value = message.message;
    } else {
      end(LIVE_VIEW_END_TEXT[message.reason]);
    }
  };
  source.onerror = () => {
    // A stream the instance refused, or one that cannot open again, is closed for good.
    if (source?.readyState === EventSource.CLOSED) end(image.value ? LIVE_VIEW_END_TEXT['worker-left'] : UNAVAILABLE);
  };
}

function end(why: string): void {
  ended.value = true;
  notice.value = why;
  disconnect();
}

function disconnect(): void {
  source?.close();
  source = null;
}

watch(
  open,
  (isOpen) => {
    if (!import.meta.client) return;
    if (isOpen) connect();
    else {
      disconnect();
      image.value = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(disconnect);

const where = computed(() => (call.value?.file ? `${call.value.file}:${call.value.line ?? ''}` : ''));
const alt = computed(
  () => `The page worker ${props.worker} is on${call.value ? `, at ${call.value.title}` : ''}, as the test sees it`,
);
</script>

<template>
  <UModal v-model:open="open" :title="`Worker ${worker} · live`" :description="test" :ui="{ content: 'sm:max-w-3xl' }">
    <template #body>
      <figure class="space-y-2" data-testid="live-view">
        <div class="relative aspect-[16/10] w-full overflow-hidden rounded-md border border-default bg-elevated">
          <img
            v-if="image"
            :src="image"
            :alt="alt"
            class="size-full object-contain"
            :class="ended ? 'opacity-40' : ''"
            data-testid="live-frame"
          />
          <p
            v-if="notice"
            role="status"
            aria-live="polite"
            class="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-highlighted"
            data-testid="live-status"
          >
            {{ notice }}
          </p>
        </div>
        <figcaption class="min-h-4 text-xs text-muted" data-testid="live-call">
          <template v-if="call">
            At <span class="font-mono">{{ call.title }}</span
            ><template v-if="where"> · {{ where }}</template>
          </template>
        </figcaption>
      </figure>
      <p class="mt-3 text-xs text-muted">
        You watch the page; nothing you do here reaches the test. The images are not stored: the run’s trace keeps the
        record.
      </p>
    </template>
  </UModal>
</template>
