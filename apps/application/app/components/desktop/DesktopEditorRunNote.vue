<script setup lang="ts">
/**
 * Desktop shell only: the runs of an editor of this machine that report to this run's page, as the server observes
 * them (`useDesktopEditorRuns`): each worker that waits at a stop, its test and its place, which opens in the IDE, and
 * the editor that answers it. Read only: the app steers none of an editor's runs, so the page says the run waits rather
 * than runs while the editor holds it.
 */
import type { HubWorker } from '@piwitests/core/run-hub';
import { testName } from '@piwitests/run-model/stop';
import type { DesktopEditorRun } from '#shared/desktop-runs';
import { desktopRunStop, desktopStopLink } from '~/utils/desktop-run-view';

const props = defineProps<{ runs: DesktopEditorRun[] }>();

/** Each run's workers at a stop, by lane. */
const stopped = computed(() =>
  props.runs.map((run) => ({
    run,
    editor: run.client ?? 'the editor',
    workers: [...run.session.workers]
      .sort((a, b) => a.parallelIndex - b.parallelIndex)
      .flatMap((worker: HubWorker) => {
        const stop = desktopRunStop(worker);
        return stop ? [{ worker, stop, link: desktopStopLink(stop, run.session.root) }] : [];
      }),
  })),
);
</script>

<template>
  <SectionCard
    v-for="{ run, editor, workers } in stopped"
    :key="run.session.ref"
    :title="`In ${editor}`"
    icon="i-lucide-code-xml"
    class="mt-4"
    data-shot="desktop-editor-run-note"
  >
    <p v-if="!workers.length" class="text-sm text-highlighted leading-relaxed">
      {{ editor }} follows this run: a test that stops waits there for you.
    </p>
    <ul v-else class="flex flex-col gap-1.5">
      <li
        v-for="{ worker, stop, link } in workers"
        :key="worker.worker"
        class="text-sm text-highlighted leading-relaxed"
      >
        <span class="font-semibold">Worker {{ worker.parallelIndex + 1 }}</span>
        {{ worker.test ? testName(worker.test) : 'A test' }}
        {{ stop.reason === 'failure' ? 'failed at' : 'waits at' }}
        <OpenInIdeLink v-if="link" :file-path="link.file" :line="link.line" :root="run.session.root" inline />
        <span v-else class="font-mono break-all">{{ stop.uri }}:{{ stop.line + 1 }}</span>
        <span class="ml-1 text-xs text-muted">· answer it in {{ editor }}</span>
      </li>
    </ul>
  </SectionCard>
</template>
