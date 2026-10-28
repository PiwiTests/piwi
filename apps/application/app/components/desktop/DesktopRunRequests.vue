<script setup lang="ts">
/**
 * Desktop shell only: the responses a stopped test of a desktop run kept, to choose the one **Mock a request** writes
 * a `page.route` for: a button each (the method and address, the status, type, size and time), the arrow keys, Home
 * and End moving between them (one tab stop), Escape closing the list, a filter from six. Every field is the page's
 * text, shown as text; the address is cut to the row and whole in its title.
 */
import type { HubKeptRequest } from '@piwitests/core/run-hub';
import { foldText } from '#shared/utils/fold-text';

const props = defineProps<{ requests: readonly HubKeptRequest[]; busy: boolean }>();
const emit = defineEmits<{ mock: [id: number]; close: [] }>();

/** From how many requests a filter box narrows the list. */
const FILTER_FROM = 6;
const titleId = useId();

const query = ref('');
const shown = computed(() => {
  const folded = foldText(query.value.trim());
  if (!folded) return props.requests;
  return props.requests.filter((r) => foldText(`${r.method} ${r.url} ${r.status} ${r.type}`).includes(folded));
});
/** The row the keyboard was on last: Tab reaches it alone. */
const current = ref<number | null>(null);
const rows = ref<HTMLButtonElement[]>([]);

function sizeText(size: number | null): string {
  if (size === null) return 'size not stated';
  return size < 1000 ? `${size} B` : `${(size / 1000).toFixed(1)} kB`;
}

/** What follows a response's status: its type, its size and when it finished. */
function factsOf(request: HubKeptRequest): string {
  return [request.type, sizeText(request.size), `at ${(request.time / 1000).toFixed(1)} s`].filter(Boolean).join(' · ');
}

function onKeydown(event: KeyboardEvent, index: number): void {
  const moves: Record<string, number> = {
    ArrowDown: index + 1,
    ArrowUp: index - 1,
    Home: 0,
    End: shown.value.length - 1,
  };
  if (!(event.key in moves)) return;
  event.preventDefault();
  rows.value[Math.max(0, Math.min(shown.value.length - 1, moves[event.key]!))]?.focus();
}

function tabIndexOf(request: HubKeptRequest, index: number): number {
  const at = shown.value.findIndex((r) => r.id === current.value);
  return (at < 0 ? index === 0 : request.id === current.value) ? 0 : -1;
}
</script>

<template>
  <div role="group" :aria-labelledby="titleId" class="space-y-2" @keydown.esc.prevent="emit('close')">
    <div class="flex items-center justify-between gap-2">
      <p :id="titleId" class="text-sm font-semibold text-highlighted">Choose the response to mock</p>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-x"
        aria-label="Close the list of responses"
        @click="emit('close')"
      />
    </div>
    <p v-if="requests.length === 0" class="text-xs text-muted">The test kept no response before this stop.</p>
    <template v-else>
      <UInput
        v-if="requests.length >= FILTER_FROM"
        v-model="query"
        size="xs"
        type="search"
        placeholder="Filter the responses"
        aria-label="Filter the responses"
        @keydown.down.prevent="rows[0]?.focus()"
      />
      <ul class="space-y-1 max-h-56 overflow-y-auto">
        <li v-for="(request, index) in shown" :key="request.id">
          <button
            :ref="(el) => (rows[index] = el as HTMLButtonElement)"
            type="button"
            :tabindex="tabIndexOf(request, index)"
            :title="`${request.method} ${request.url}`"
            :aria-disabled="busy || undefined"
            class="w-full text-left rounded-md border border-default px-2 py-1 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
            @focus="current = request.id"
            @keydown="onKeydown($event, index)"
            @click="!busy && emit('mock', request.id)"
          >
            <span class="flex gap-1.5 text-xs font-mono min-w-0">
              <span class="font-semibold shrink-0">{{ request.method }}</span>
              <span class="truncate">{{ request.url }}</span>
            </span>
            <span class="block text-xs text-muted">
              <span :class="request.status >= 400 ? 'text-error' : ''">{{ request.status }}</span>
              · {{ factsOf(request) }}
            </span>
          </button>
        </li>
      </ul>
      <p v-if="shown.length === 0" class="text-xs text-muted">No response matches.</p>
    </template>
  </div>
</template>
