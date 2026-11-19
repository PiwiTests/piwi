<script setup lang="ts">
/**
 * A run going on: where it stands, its name, its project, when it started and how long it has run, and Stop. Then,
 * live, its workers as the hub tells them (`DesktopRunSession`, the layer's): each worker's test, Pause, Step, Resume
 * and the stopped test's page, with **Hold failures**, which keeps a failure no pause bar shows waiting here; while the
 * window does not hear the hub, its number and page on the instance once named. Last, the tests the request asked for
 * and the run's output (`RunnerRunOutput`). A run nobody attends offers no Hold failures.
 */
import { isUnattendedRef } from '@piwitests/core/run-channel';
import type { HubSession } from '@piwitests/core/run-hub';
import { isRunnerRunRef, type RunnerRun } from '~/utils/runner-runs';

const props = defineProps<{ run: RunnerRun }>();
const emit = defineEmits<{ announce: [text: string] }>();

const { stopRun, setHold } = useRunnerRuns();
const hub = useDesktopRunHub();
const { t } = useRunnerWords();
const { status, name, details } = useRunnerRunView(() => props.run);

/** The hub's live run of this run, while the window hears the hub. */
const session = computed<HubSession | null>(() => {
  const sessions = Object.values(hub.state.sessions) as HubSession[];
  return sessions.find((each) => isRunnerRunRef(each.ref, props.run.shellId)) ?? null;
});
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }" data-testid="runner-run" :data-status="run.status">
    <div class="flex flex-wrap items-start gap-x-3 gap-y-2 p-4">
      <span :class="['flex size-9 shrink-0 items-center justify-center rounded-full', status.mark]" aria-hidden="true">
        <UIcon :name="status.icon" class="size-5 animate-spin" />
      </span>
      <div class="min-w-0 flex-1 basis-48">
        <p class="text-sm font-medium break-words text-highlighted">{{ name }}</p>
        <p class="text-xs text-muted">{{ details.join(' · ') }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <UBadge :color="status.tone" variant="subtle">{{ status.words }}</UBadge>
        <UButton
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
      <RunnerRunTests v-if="run.tests.length" :run="run" />
      <RunnerRunOutput v-if="run.lines.length" :run="run" />
    </div>
  </UCard>
</template>
