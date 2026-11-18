<script setup lang="ts">
/**
 * One run of the window: where it stands, its name, its project, when it started and how long it took (counting while
 * it runs), and Stop while it runs. Then, live, its workers as the hub tells them (`DesktopRunSession`, the layer's):
 * each worker's test, Pause, Step, Resume and the stopped test's page, with **Hold failures**, which keeps a failure no
 * pause bar shows waiting here, and its number and page on the instance (**Run #78 · Open**), which stay once the run
 * ended. Last, the tests the request asked for and the run's output (`RunnerRunOutput`). A run nobody attends offers
 * no Hold failures.
 */
import { isUnattendedRef } from '@piwitests/core/run-channel';
import type { HubSession } from '@piwitests/core/run-hub';
import { isRunnerRunRef, runnerRunDuration, type RunnerRun, type RunnerRunStatus } from '~/utils/runner-runs';

type RunnerStatusKey =
  | 'runner_statusRunning'
  | 'runner_statusPassed'
  | 'runner_statusFailed'
  | 'runner_statusStopped'
  | 'runner_statusError';
type Tone = 'primary' | 'success' | 'error' | 'neutral';

const props = defineProps<{ run: RunnerRun }>();
const emit = defineEmits<{ announce: [text: string] }>();

const { stopRun, setHold } = useRunnerRuns();
const hub = useDesktopRunHub();
const words = useRunUiWords();
const { t } = useRunnerWords();

const STATUS: Record<RunnerRunStatus, { label: RunnerStatusKey; tone: Tone; icon: string }> = {
  running: { label: 'runner_statusRunning', tone: 'primary', icon: 'i-lucide-loader-circle' },
  passed: { label: 'runner_statusPassed', tone: 'success', icon: 'i-lucide-circle-check' },
  failed: { label: 'runner_statusFailed', tone: 'error', icon: 'i-lucide-circle-x' },
  stopped: { label: 'runner_statusStopped', tone: 'neutral', icon: 'i-lucide-circle-stop' },
  error: { label: 'runner_statusError', tone: 'error', icon: 'i-lucide-triangle-alert' },
};
const TONE_CLASSES: Record<Tone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  error: 'bg-error/10 text-error',
  neutral: 'bg-elevated text-muted',
};

const status = computed(() => STATUS[props.run.status]);
const running = computed(() => props.run.status === 'running');

/** The clock of the duration: it ticks while the run runs, and stops with it. */
const { now, pause, resume } = useNow({ interval: 1000, controls: true });
watch(running, (on) => (on ? resume() : pause()), { immediate: true });

function durationWords(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? words.t('runui_durationSeconds', { seconds: words.number(seconds) })
    : words.t('runui_durationMinutes', { minutes: words.number(Math.floor(seconds / 60)), seconds: seconds % 60 });
}

/** The run's project, when it started and how long it took. */
const details = computed(() =>
  [
    props.run.projectName,
    t('runner_startedAt', { time: words.time(new Date(props.run.startedAt)) }),
    durationWords(runnerRunDuration(props.run, now.value.getTime())),
  ].filter(Boolean),
);

/** The hub's live run of this run, while it runs and the window hears the hub. */
const session = computed<HubSession | null>(() => {
  if (!running.value) return null;
  const sessions = Object.values(hub.state.sessions) as HubSession[];
  return sessions.find((each) => isRunnerRunRef(each.ref, props.run.shellId)) ?? null;
});
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }" data-testid="runner-run" :data-status="run.status">
    <div class="flex flex-wrap items-start gap-x-3 gap-y-2 p-4">
      <span
        :class="['flex size-9 shrink-0 items-center justify-center rounded-full', TONE_CLASSES[status.tone]]"
        aria-hidden="true"
      >
        <UIcon :name="status.icon" :class="['size-5', running && 'animate-spin']" />
      </span>
      <div class="min-w-0 flex-1 basis-48">
        <p class="text-sm font-medium break-words text-highlighted">{{ run.title }}</p>
        <p class="text-xs text-muted">{{ details.join(' · ') }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <UBadge :color="status.tone" variant="subtle">
          {{ run.stopRequested && running ? t('runner_stopping') : t(status.label) }}
        </UBadge>
        <UButton
          v-if="running"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-square"
          :disabled="run.shellId === null"
          @click="stopRun(run)"
        >
          {{ run.stopRequested ? t('runner_stopNow') : t('runner_stop') }}
        </UButton>
      </div>
    </div>
    <div v-if="session || run.page" class="space-y-3 border-t border-default px-4 py-3">
      <template v-if="session">
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
      </template>
      <DesktopRunPageLink v-else-if="run.page" :page="run.page" />
    </div>
    <div v-if="run.tests.length || run.lines.length" class="divide-y divide-default border-t border-default">
      <details v-if="run.tests.length" class="group" data-testid="runner-run-tests">
        <summary
          class="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs text-muted hover:text-default [&::-webkit-details-marker]:hidden"
        >
          <UIcon name="i-lucide-chevron-right" class="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
          <span class="font-medium">{{ words.tn('runui_tests', run.tests.length) }}</span>
        </summary>
        <ul class="space-y-1.5 px-4 pb-3 text-sm">
          <li v-for="test in run.tests" :key="`${test.filePath}:${test.line}:${test.projectName}`" class="min-w-0">
            <span class="text-highlighted">{{ test.title }}</span>
            <code class="block text-xs break-all text-muted"
              >{{ test.filePath }}{{ test.line ? `:${test.line}` : ''
              }}{{ test.projectName ? ` (${test.projectName})` : '' }}</code
            >
          </li>
        </ul>
      </details>
      <RunnerRunOutput v-if="run.lines.length" :run="run" />
    </div>
  </UCard>
</template>
