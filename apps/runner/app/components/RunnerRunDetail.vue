<script setup lang="ts">
/**
 * The run shown beside the list of runs: how it stands, its name, its project, when it started and how long it has run
 * or took, Stop while it goes on, which gives way to Force stop while it winds down (`DesktopRunStopButton`, the
 * layer's), and its number and page on the instance (**Run #78 · Open**) once its process named them. While it goes on
 * and the window hears the hub, its workers live (`DesktopRunSession`, the layer's): each worker's test, Pause, Step,
 * Resume and the stopped test's page, with **Hold failures**, which keeps a failure no pause bar shows waiting here; a
 * run nobody attends offers no Hold failures. Then the tests the request asked for, how each came out once the run
 * ended (`runnerTestResults`, in the layer's `DesktopRunResults`), a failed one with the first lines of its error, and
 * its output (`DesktopRunOutputPane`), Playwright's colors included, with its filter, Go to the first error and Copy
 * output.
 */
import { isUnattendedRef } from '@piwitests/core/run-channel';
import type { HubSession } from '@piwitests/core/run-hub';
import { isRunnerRunRef, runnerTestResults, type RunnerRun } from '~/utils/runner-runs';

const props = defineProps<{ run: RunnerRun }>();
const emit = defineEmits<{ announce: [text: string] }>();

const { stopRun, setHold } = useRunnerRuns();
const hub = useDesktopRunHub();
const words = useRunUiWords();
const { t, tn } = useRunnerWords();
const view = useRunnerRunView();

const status = computed(() => view.status(props.run));
const name = computed(() => view.name(props.run));
const results = computed(() => runnerTestResults(props.run));

/** The hub's live run of this run, while it goes on and the window hears the hub. */
const session = computed<HubSession | null>(() => {
  if (props.run.status !== 'running') return null;
  const sessions = Object.values(hub.state.sessions) as HubSession[];
  return sessions.find((each) => isRunnerRunRef(each.ref, props.run.shellId)) ?? null;
});
</script>

<template>
  <article class="space-y-4" :aria-label="name" data-testid="runner-run" :data-status="run.status">
    <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
      <span :class="['flex size-9 shrink-0 items-center justify-center rounded-full', status.mark]" aria-hidden="true">
        <UIcon :name="status.icon" :class="['size-5', run.status === 'running' && 'animate-spin']" />
      </span>
      <div class="min-w-0 flex-1 basis-48">
        <h2 class="text-sm font-semibold break-words text-highlighted">{{ name }}</h2>
        <p class="text-xs text-muted">
          <span :class="['font-medium', status.text]">{{ status.words }}</span
          >{{
            view
              .details(run)
              .map((part) => ` · ${part}`)
              .join('')
          }}
        </p>
      </div>
      <div class="flex shrink-0 flex-wrap items-center gap-2">
        <DesktopRunPageLink v-if="run.page && !session" :page="run.page" />
        <DesktopRunStopButton
          v-if="run.status === 'running'"
          :stopping="run.stopRequested"
          :since="run.stopRequestedAt"
          :disabled="run.shellId === null"
          @stop="stopRun(run)"
          @force="stopRun(run)"
        />
      </div>
    </div>

    <div v-if="session" class="space-y-3">
      <USwitch
        v-if="!isUnattendedRef(session.ref)"
        :model-value="run.holdFailures"
        size="sm"
        :label="t('runner_holdFailures')"
        :description="t('runner_holdFailuresHint')"
        data-testid="runner-hold-failures"
        @update:model-value="setHold(run, $event)"
      />
      <DesktopRunSession :session="session" @announce="emit('announce', $event)" />
    </div>

    <section v-if="run.tests.length" class="space-y-2" data-testid="runner-run-tests">
      <h3 class="text-xs font-medium text-muted">{{ words.tn('runui_tests', run.tests.length) }}</h3>
      <DesktopRunResults v-if="results" :rows="results" :limit="10" />
      <ul v-else class="space-y-1.5 text-sm">
        <li v-for="test in run.tests" :key="`${test.filePath}:${test.line}:${test.projectName}`" class="min-w-0">
          <span class="text-highlighted">{{ test.title }}</span>
          <code class="block text-xs break-all text-muted"
            >{{ test.filePath }}{{ test.line ? `:${test.line}` : ''
            }}{{ test.projectName ? ` (${test.projectName})` : '' }}</code
          >
        </li>
      </ul>
    </section>

    <section v-if="run.lines.length || run.status === 'running'" class="space-y-2" data-testid="runner-run-output">
      <h3 class="text-xs font-medium text-muted">
        {{ `${t('runner_output')} · ${tn('runner_outputLines', run.linesTotal)}` }}
      </h3>
      <DesktopRunOutputPane :lines="run.lines" />
    </section>
  </article>
</template>
