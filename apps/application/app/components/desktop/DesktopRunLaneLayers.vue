<script setup lang="ts">
/**
 * Desktop shell only: a watched lane's layers under its page in the Local runs tray, as Piwi Picker's Runs window shows
 * them (`@piwitests/run-model/layers`), once its worker's reporter sent one (`useDesktopRunHub().laneLayers`): **Why it
 * waits** (the call, how long it has run or how it ended, what its locator matches and whether its element is enabled,
 * the latest lines of Playwright's log of it), **Events** (newest first, a pending request one line whose time grows),
 * **Text** (the page's ARIA text, its secret fields hidden, which **Show the page's text** asks for, then followed,
 * **Take it again** and **Hide the text**) and **Filmstrip** (an image for each call that ended, each a button that
 * shows it larger with its call's title). Everything the hub sends is shown as text, and an image only as a `data:`
 * JPEG whose base64 `takeLaneLayer` checked again, its URL made once for each image.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import {
  callWait,
  englishSeconds,
  laneEventSaid,
  laneTextSource,
  type LaneFilmEntry,
} from '@piwitests/run-model/layers';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import { desktopSay } from '~/utils/desktop-run-view';

const props = defineProps<{
  session: HubSession;
  worker: HubWorker;
  /** A command for this worker is on its way: the text's buttons wait for it. */
  busy: boolean;
}>();

const hub = useDesktopRunHub();
const runRef = computed(() => props.session.ref);
const lane = computed(() => props.worker.parallelIndex);
const layers = computed(() => hub.laneLayers(runRef.value, lane.value));
const text = computed(() => hub.laneText(runRef.value, lane.value));

const wait = computed(() => (layers.value?.log ? callWait(layers.value.log, englishRunSpeaker, englishSeconds) : null));
const events = computed(() =>
  (layers.value?.events ?? []).map((entry) => ({
    key: entry.key,
    ...laneEventSaid(entry.event, englishRunSpeaker, englishSeconds),
  })),
);

/** The filmstrip, the same list until an image of it changes. */
const film = computed(() => layers.value?.film ?? []);
/** Each image's `data:` URL, made once for it. */
const filmUrls = new WeakMap<LaneFilmEntry, string>();
function filmUrl(entry: LaneFilmEntry): string {
  let url = filmUrls.get(entry);
  if (!url) {
    url = `data:image/jpeg;base64,${entry.data}`;
    filmUrls.set(entry, url);
  }
  return url;
}
/** The image of the filmstrip shown larger, by its call's id. */
const chosen = ref<string | null>(null);
const shown = computed(() => film.value.find((entry) => entry.thumb.call === chosen.value) ?? null);

/** Why the hub did not take the ask for the page's text. */
const textNote = ref('');

async function askText(on: boolean): Promise<void> {
  if (props.busy) return;
  textNote.value = '';
  const answer = await hub.askLaneText(runRef.value, lane.value, on);
  if (!answer.ok) textNote.value = answer.message;
}

const ids = { calls: useId(), events: useId(), text: useId(), film: useId() };
</script>

<template>
  <div v-if="layers" class="grid gap-2.5" data-testid="desktop-lane-layers">
    <section class="grid gap-1 min-w-0" :aria-labelledby="ids.calls">
      <h4 :id="ids.calls" class="text-xs font-semibold text-muted">{{ desktopSay('runs_layerCalls') }}</h4>
      <p v-if="!wait" class="text-xs text-muted">{{ desktopSay('runs_callNone') }}</p>
      <template v-else>
        <p class="text-xs break-words">
          <code class="font-mono text-highlighted">{{ wait.title }}</code>
          <template v-if="wait.place">
            {{ ' ' }}<span class="font-mono text-muted">{{ wait.place }}</span>
          </template>
        </p>
        <p class="text-xs" :class="getStatusTextClass(wait.tone)" data-testid="desktop-lane-call-state">
          {{ wait.state }}<template v-if="wait.target"> · {{ wait.target }}</template>
        </p>
        <p v-if="wait.error" class="text-xs text-error break-words">{{ wait.error }}</p>
        <pre
          v-if="wait.lines.length"
          class="m-0 max-h-40 overflow-auto rounded-md border border-default bg-muted px-2 py-1.5 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words"
          >{{ wait.lines.join('\n') }}</pre>
      </template>
    </section>

    <section class="grid gap-1 min-w-0" :aria-labelledby="ids.events">
      <h4 :id="ids.events" class="text-xs font-semibold text-muted">{{ desktopSay('runs_layerEvents') }}</h4>
      <p v-if="!events.length" class="text-xs text-muted">{{ desktopSay('runs_eventsNone') }}</p>
      <ul
        v-else
        class="m-0 grid max-h-44 gap-0.5 overflow-auto p-0 text-xs list-none"
        data-testid="desktop-lane-events"
      >
        <li v-for="event in events" :key="event.key" class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-2">
          <span class="text-muted break-words">{{ event.label }}</span>
          <template v-if="event.text">
            {{ ' ' }}<span class="font-mono text-[11px] text-highlighted break-words">{{ event.text }}</span>
          </template>
        </li>
      </ul>
    </section>

    <section class="grid gap-1 min-w-0" :aria-labelledby="ids.text">
      <h4 :id="ids.text" class="text-xs font-semibold text-muted">{{ desktopSay('runs_layerText') }}</h4>
      <div class="flex flex-wrap gap-1.5">
        <UButton
          v-if="!text.asked"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-list-tree"
          :title="desktopSay('runs_textShowTitle')"
          :aria-disabled="busy || undefined"
          @click="askText(true)"
        >
          {{ desktopSay('runs_textShow') }}
        </UButton>
        <template v-else>
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            :aria-disabled="busy || undefined"
            @click="askText(true)"
          >
            {{ desktopSay('runs_textAgain') }}
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-eye-off"
            :aria-disabled="busy || undefined"
            @click="askText(false)"
          >
            {{ desktopSay('runs_textHide') }}
          </UButton>
        </template>
      </div>
      <template v-if="text.asked">
        <p v-if="text.asking" class="text-xs text-muted">{{ desktopSay('runs_textWaiting') }}</p>
        <p v-if="textNote || layers.textRefused" class="flex items-start gap-1.5 text-xs text-warning">
          <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {{ textNote || layers.textRefused }}
        </p>
        <template v-if="layers.text">
          <p class="text-xs text-muted">{{ laneTextSource(layers.text, englishRunSpeaker) }}</p>
          <pre
            class="m-0 max-h-60 overflow-auto rounded-md border border-default bg-muted px-2 py-1.5 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words focus-visible:outline-2 focus-visible:outline-primary"
            tabindex="0"
            :aria-label="desktopSay('runs_textLabel')"
            data-testid="desktop-lane-text"
            >{{ layers.text.text }}</pre>
        </template>
      </template>
    </section>

    <section class="grid gap-1 min-w-0" :aria-labelledby="ids.film">
      <h4 :id="ids.film" class="text-xs font-semibold text-muted">{{ desktopSay('runs_layerFilmstrip') }}</h4>
      <p v-if="!film.length" class="text-xs text-muted">{{ desktopSay('runs_filmstripNone') }}</p>
      <template v-else>
        <template v-if="shown">
          <figure class="m-0 overflow-hidden rounded-md border border-default bg-muted">
            <img
              class="block w-full h-auto"
              :src="filmUrl(shown)"
              :alt="desktopSay('runs_filmstripAlt', { call: shown.thumb.title })"
            />
            <figcaption class="px-2 py-1 font-mono text-xs break-words">{{ shown.thumb.title }}</figcaption>
          </figure>
          <div>
            <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-x" @click="chosen = null">
              {{ desktopSay('runs_filmstripClose') }}
            </UButton>
          </div>
        </template>
        <ul class="m-0 flex gap-1 overflow-x-auto p-1 list-none" data-testid="desktop-lane-film">
          <li v-for="entry in film" :key="entry.thumb.call" class="shrink-0">
            <button
              type="button"
              class="block rounded border border-default bg-default p-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
              :class="entry === shown ? CURRENT_ITEM_RING_CLASS : ''"
              :title="entry.thumb.title"
              :aria-pressed="entry === shown"
              @click="chosen = entry === shown ? null : entry.thumb.call"
            >
              <img
                class="block w-20 h-auto"
                :src="filmUrl(entry)"
                :alt="desktopSay('runs_filmstripAlt', { call: entry.thumb.title })"
              />
            </button>
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>
