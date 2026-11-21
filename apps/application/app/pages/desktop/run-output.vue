<script setup lang="ts">
import { DESKTOP_APP_NAME } from '#shared/piwi-ecosystem';
/**
 * Desktop shell only: a local run in a window of its own, which the Local runs tray has the shell open on this page
 * (`DesktopRunOutputWindow`), named by `?name=`. The tray feeds it over `RUN_OUTPUT_CHANNEL`: the run's header, what it
 * offers and its new lines. It shows the whole run, as the tray does: its command, Stop then Force stop
 * (`DesktopRunStopButton`) or Run again, its Hold failures, its pages (Open the failure, Open run #N, Compare), its
 * workers live (`DesktopRunSession`), what it failed on once it ended, each test to open or run again
 * (`DesktopRunResults`), and its output (`DesktopRunOutputPane`). What only the dashboard window does, it asks over the
 * channel: a page opens there, a Run again's run shows here in its place, and **Show in the tray** brings the run back
 * there and closes this window.
 *
 * The window holds the runs' hub stream itself (`useDesktopRunHub`) while its run goes on, present on the runs while it
 * is not hidden, and says `show` for its run while the run's Hold failures is on, as the tray does; it lets the stream
 * go once the run ended. It outlives a reload of the dashboard window, whose next page asks whether it is still there
 * and feeds it again from the last line it has. A window of its own: no layout.
 */
import type { HubSession } from '@piwitests/core/run-hub';
import { LOCAL_RUN_MAX_LINES, localRunDuration } from '~/composables/useDesktopLocalRuns';
import type { RunOutputLine, RunResultRow } from '@piwitests/run-ui/run-output';
import { desktopRunOf } from '~/utils/desktop-run-view';
import {
  mergeRunOutputLines,
  RUN_OUTPUT_CHANNEL,
  type RunOutputMessage,
  type RunOutputState,
  type RunWindowPage,
  type RunWindowRow,
} from '~/utils/run-output-channel';

definePageMeta({ layout: false });

const name = String(useRoute().query.name ?? '');
const header = shallowRef<Omit<RunOutputState, 'lines'> | null>(null);
const lines = shallowRef<RunOutputLine[]>([]);
let channel: BroadcastChannel | null = null;

/** Says something to the dashboard window, which does what only it does. */
function post(message: RunOutputMessage) {
  channel?.postMessage(message);
}

/** Says the window is ready for the run's state, from the line after the last one it has. */
function ready() {
  post({ type: 'ready', name, through: lines.value.at(-1)?.id ?? 0 });
}

onMounted(() => {
  channel = new BroadcastChannel(RUN_OUTPUT_CHANNEL);
  channel.onmessage = ({ data }: MessageEvent<RunOutputMessage>) => {
    if (!data || !('name' in data) || data.name !== name) return;
    if (data.type === 'ask') return ready();
    if (data.type !== 'state') return;
    const { lines: sent, ...rest } = data;
    lines.value = mergeRunOutputLines(lines.value, header.value?.key ?? null, data, LOCAL_RUN_MAX_LINES);
    header.value = rest;
  };
  ready();
});

onBeforeUnmount(() => channel?.close());

const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });

useHead(() => ({ title: `${header.value?.title ?? 'Local run'} · ${DESKTOP_APP_NAME}` }));

// ── Its workers live ──────────────────────────────────────────────────────────────────────────────────────────────

const hub = useDesktopRunHub();
const visibility = useDocumentVisibility();
const running = computed(() => !!header.value?.running);
const visible = computed(() => visibility.value === 'visible');

/** The hub's live runs of the run: its steps'. */
const sessions = computed(() => {
  const refs = header.value?.refs ?? [];
  return (Object.values(hub.state.sessions) as HubSession[]).filter((session) =>
    refs.includes(desktopRunOf(session.ref)),
  );
});

onMounted(() => {
  watch(running, (on) => hub.want(on), { immediate: true });
  watch(
    () => running.value && visible.value,
    (on) => hub.present(on),
    { immediate: true },
  );
  watch(
    () => (running.value && visible.value && header.value?.hold?.on ? (header.value?.refs ?? []) : []).join(' '),
    (refs) => hub.show(refs ? refs.split(' ') : []),
    { immediate: true },
  );
});
onBeforeUnmount(() => {
  hub.show([]);
  hub.present(false);
  hub.want(false);
});

/** What the live region reads out: what a command answered. */
const announcement = ref('');
function announce(text: string) {
  announcement.value = '';
  requestAnimationFrame(() => {
    announcement.value = text;
  });
}

// ── What it asks the dashboard window ─────────────────────────────────────────────────────────────────────────────

function stop() {
  post({ type: 'stop', name });
}

function setHold(on: boolean) {
  post({ type: 'hold', name, on });
}

function open(page: RunWindowPage) {
  post({ type: 'open', name, page });
}

/** What a row's buttons say of its test: its title, and its project when it has one. */
const named = (row: RunResultRow) => (row.project ? `${row.title} in ${row.project}` : row.title);

function runTestAgain(row: RunResultRow, hold: boolean) {
  post({ type: 'rerun-test', name, row: row.key, hold });
}
</script>

<template>
  <main aria-label="Local run" class="flex h-dvh flex-col bg-default">
    <header class="flex shrink-0 flex-col gap-1 border-b border-default px-3 py-2">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <template v-if="header">
          <UBadge :color="header.status.color" variant="subtle" size="sm" class="shrink-0">
            {{ header.status.label }}
          </UBadge>
          <h1 class="min-w-0 flex-1 basis-48 truncate text-sm font-semibold text-highlighted" :title="header.title">
            {{ header.title }}
          </h1>
          <span class="shrink-0 text-xs text-muted tabular-nums">
            {{ localRunDuration(header.startedAt, header.finishedAt, now) }}
          </span>
          <div class="flex shrink-0 items-center gap-1">
            <DesktopRunStopButton
              v-if="header.running"
              :stopping="header.stopRequested"
              :since="header.stopRequestedAt"
              @stop="stop"
              @force="stop"
            />
            <UTooltip v-else-if="header.rerunnable" :text="`Run again: ${header.title}, with the same options`">
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                icon="i-lucide-rotate-ccw"
                aria-label="Run again"
                @click="post({ type: 'rerun', name })"
              />
            </UTooltip>
            <UTooltip text="Show the run in the tray and close this window">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-panel-bottom-open"
                aria-label="Show in the tray"
                @click="post({ type: 'back', name })"
              />
            </UTooltip>
          </div>
        </template>
        <h1 v-else class="text-sm font-semibold text-highlighted">Local run</h1>
      </div>
      <template v-if="header">
        <p class="truncate font-mono text-xs text-muted" :title="header.detail">{{ header.detail }}</p>
        <p v-if="header.note" class="text-xs text-warning">{{ header.note }}</p>
      </template>
    </header>

    <div v-if="header" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2">
      <div v-if="header.hold" class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
        <USwitch
          :model-value="header.hold.on"
          :disabled="!!header.hold.refusal"
          label="Hold failures"
          size="sm"
          aria-describedby="run-window-hold"
          :ui="{ label: 'text-xs font-medium' }"
          @update:model-value="(on: boolean) => setHold(on)"
        />
        <p id="run-window-hold" class="min-w-0 text-xs text-muted">
          {{ header.hold.refusal ?? 'A failing test waits at its line for you to look at it and resume.' }}
        </p>
      </div>
      <div v-if="header.piwiRunId != null" class="flex shrink-0 flex-wrap items-center gap-2">
        <UButton
          v-if="header.failed"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-external-link"
          @click="open('failure')"
        >
          Open the failure
        </UButton>
        <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-external-link" @click="open('run')">
          Open run #{{ header.piwiRunId }}
        </UButton>
        <UButton
          v-if="header.sourceRunId != null"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-git-compare"
          :title="`What changed between run #${header.sourceRunId}, where these tests come from, and this one`"
          @click="open('compare')"
        >
          Compare with run #{{ header.sourceRunId }}
        </UButton>
      </div>
      <DesktopRunSession v-for="session in sessions" :key="session.ref" :session="session" @announce="announce" />
      <DesktopRunResults v-if="header.rows.length > 0" :rows="header.rows" class="shrink-0">
        <template #place="{ row }">
          <OpenInIdeLink
            v-if="row.place"
            :location="row.place"
            :project-key="header.projectId"
            :project-name="header.projectLabel"
            class="text-xs"
          />
        </template>
        <template #actions="{ row }">
          <UButton
            v-if="(row as RunWindowRow).executionId != null"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-external-link"
            :aria-label="`Open ${named(row)}`"
            title="Open its execution in the dashboard window"
            @click="open({ execution: (row as RunWindowRow).executionId! })"
          />
          <template v-if="(row as RunWindowRow).rerunnable">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-rotate-ccw"
              :aria-label="`Run ${named(row)} again`"
              title="Run this test again, as the run ran it, in this window"
              @click="runTestAgain(row, false)"
            />
            <UButton
              v-if="header.rowsHold"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-circle-pause"
              :aria-label="`Run ${named(row)} again with Hold failures`"
              title="Run this test again, waiting at its failure for you to look"
              @click="runTestAgain(row, true)"
            />
          </template>
        </template>
      </DesktopRunResults>
      <DesktopRunOutputPane :lines="lines" fill class="min-h-48 flex-1" />
    </div>
    <p role="status" aria-live="polite" class="sr-only">{{ announcement }}</p>
  </main>
</template>
