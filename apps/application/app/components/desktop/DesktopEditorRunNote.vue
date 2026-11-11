<script setup lang="ts">
/**
 * Desktop shell only: the runs of an editor of this machine that report to this run's page, as the server observes
 * them (`useDesktopEditorRuns`): each worker that waits at a stop, its test and its place, which opens in the IDE, and
 * the editor that answers it. Read only: the app steers none of an editor's runs, so the page says the run waits rather
 * than runs while the editor holds it.
 */
import type { HubWorker } from '@piwitests/core/run-hub';
import { stopPlace, testName } from '@piwitests/run-model/stop';
import type { DesktopEditorRun } from '#shared/desktop-runs';
import { desktopRunStop, desktopStopLink } from '~/utils/desktop-run-view';

const props = defineProps<{ runs: DesktopEditorRun[] }>();

/** Each run's workers at a stop, by lane, and the editor that answers them, as a title and inside a sentence. */
const stopped = computed(() =>
  props.runs.map((run) => ({
    run,
    title: run.client ?? 'Your editor',
    editor: run.client ?? 'your editor',
    workers: [...run.session.workers]
      .sort((a, b) => a.parallelIndex - b.parallelIndex)
      .flatMap((worker: HubWorker) => {
        const stop = desktopRunStop(worker);
        return stop
          ? [{ worker, stop, link: desktopStopLink(stop, run.session.root), place: stopPlace(stop, run.session.root) }]
          : [];
      }),
  })),
);
</script>

<template>
  <SectionCard
    v-for="{ run, title, editor, workers } in stopped"
    :key="run.session.ref"
    :title="`In ${title}`"
    icon="i-lucide-code-xml"
    class="mt-4"
    data-shot="desktop-editor-run-note"
  >
    <p v-if="!workers.length" class="text-sm text-highlighted leading-relaxed">
      {{ title }} follows this run: a test that stops waits there for you.
    </p>
    <!-- From lg the page's summary does not scroll: the list scrolls inside, so the tabs below keep their room. -->
    <dl v-else class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 lg:max-h-[40dvh] lg:overflow-y-auto">
      <template v-for="{ worker, stop, link, place } in workers" :key="worker.worker">
        <dt class="text-sm font-semibold text-highlighted">Worker {{ worker.parallelIndex + 1 }}</dt>
        <dd class="min-w-0 text-sm text-highlighted leading-relaxed">
          {{ worker.test ? testName(worker.test) : 'A test' }}
          {{ stop.reason === 'failure' ? 'failed at' : 'waits at' }}
          <OpenInIdeLink v-if="link" :file-path="link.file" :line="link.line" :root="run.session.root" inline />
          <span v-else class="font-mono break-all">{{ place }}</span>
          <span class="ml-1 text-xs text-muted">· answer it in {{ editor }}</span>
        </dd>
      </template>
    </dl>
  </SectionCard>
</template>
