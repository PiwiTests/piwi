<script setup lang="ts">
/**
 * Desktop shell only: the "Local runs" tray — a fixed bottom-right panel
 * listing this session's local test runs with their streaming consoles, the
 * desktop cousin of a browser's downloads tray. Mounted once in the default
 * layout; runs keep going while it is closed, and closing it never stops
 * anything. Renders nothing without the IPC bridge.
 */
import { flakeLabOutcome, type LocalRun } from '~/composables/useDesktopLocalRuns';

const store = useDesktopLocalRuns();
const { runs, trayOpen, activeCount } = store;

const available = ref(false);
onMounted(() => {
  available.value = !!tauriCore();
});

// This component is mounted once in the layout, which makes it the natural
// owner of the store's Piwi-run correlation: every server run event (the
// reporter checking in counts) re-checks pending local runs.
useRunStream(() => store.correlatePiwiRuns());

/** Manual expand/collapse choices; unset falls back to the default below. */
const expandedByKey = ref<Record<number, boolean>>({});

function isExpanded(run: LocalRun): boolean {
  return expandedByKey.value[run.key] ?? (run.status === 'running' || run.key === runs.value[0]?.key);
}

function toggleExpanded(run: LocalRun) {
  expandedByKey.value = { ...expandedByKey.value, [run.key]: !isExpanded(run) };
}

const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });

function duration(run: LocalRun): string {
  const ms = (run.finishedAt ?? now.value) - run.startedAt;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function badge(run: LocalRun): { label: string; color: 'info' | 'success' | 'error' | 'neutral' } {
  switch (run.status) {
    case 'running':
      return { label: localRunProgressLabel(run), color: run.stopRequested ? 'neutral' : 'info' };
    case 'passed':
      if (run.kind === 'flake') {
        return flakeLabOutcome(run.exitCode) === 'reproduced'
          ? { label: 'Reproduced', color: 'success' }
          : { label: 'Not reproduced', color: 'neutral' };
      }
      return { label: 'Passed', color: 'success' };
    case 'failed':
      return { label: run.exitCode != null ? `Failed (exit ${run.exitCode})` : 'Failed', color: 'error' };
    case 'stopped':
      return { label: 'Stopped', color: 'neutral' };
    default:
      return { label: 'Could not run', color: 'error' };
  }
}

const hasFinished = computed(() => runs.value.some((r) => r.status !== 'running'));
</script>

<template>
  <Teleport to="body">
    <section
      v-if="available && trayOpen"
      aria-label="Local runs"
      class="fixed bottom-4 right-4 z-40 w-[600px] max-w-[calc(100vw-2rem)] rounded-lg border border-default bg-default shadow-xl"
    >
      <header class="flex items-center gap-2 px-3 py-2 border-b border-default">
        <UIcon name="i-lucide-terminal" class="size-4 text-muted shrink-0" />
        <h2 class="text-sm font-semibold">Local runs</h2>
        <UBadge v-if="activeCount > 0" color="info" variant="subtle" size="sm">{{ activeCount }} active</UBadge>
        <span class="flex-1" />
        <UTooltip v-if="hasFinished" text="Clear finished runs">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-trash-2"
            aria-label="Clear finished runs"
            @click="store.clearFinished()"
          />
        </UTooltip>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          aria-label="Close local runs"
          @click="trayOpen = false"
        />
      </header>

      <div class="max-h-[60vh] overflow-y-auto divide-y divide-default">
        <p v-if="runs.length === 0" class="px-3 py-6 text-sm text-muted text-center">
          No local runs yet — start one from a “Run locally” button.
        </p>

        <article v-for="run in runs" :key="run.key" class="px-3 py-2">
          <div class="flex items-center gap-2 min-w-0">
            <UBadge :color="badge(run).color" variant="subtle" size="sm" class="shrink-0">
              {{ badge(run).label }}
            </UBadge>
            <span class="text-sm font-medium truncate shrink-0 max-w-40">
              {{ run.projectLabel || `Project ${run.projectId}` }}
            </span>
            <code class="text-[11px] text-muted truncate flex-1 min-w-0" :title="run.steps[run.stepIndex]?.display">
              {{ run.steps[run.stepIndex]?.display }}
            </code>
            <span class="text-xs text-muted tabular-nums shrink-0">{{ duration(run) }}</span>
            <UTooltip v-if="run.status === 'running' && run.stopRequested" text="Kill the process without waiting">
              <UButton size="xs" color="error" variant="solid" icon="i-lucide-square" @click="store.stopRun(run)">
                Force stop
              </UButton>
            </UTooltip>
            <UButton
              v-else-if="run.status === 'running'"
              size="xs"
              color="error"
              variant="soft"
              icon="i-lucide-square"
              @click="store.stopRun(run)"
            >
              Stop
            </UButton>
            <UTooltip v-else-if="run.kind !== 'flake' || run.flake" text="Run again with the same options">
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                icon="i-lucide-rotate-ccw"
                aria-label="Run again"
                @click="store.rerun(run)"
              />
            </UTooltip>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="isExpanded(run) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-left'"
              :aria-label="isExpanded(run) ? 'Collapse output' : 'Expand output'"
              @click="toggleExpanded(run)"
            />
          </div>
          <div v-if="run.piwiRunId != null" class="mt-1.5">
            <UButton
              size="xs"
              color="success"
              variant="soft"
              icon="i-lucide-external-link"
              :to="`/test-runs/${run.piwiRunId}`"
              @click="trayOpen = false"
            >
              Live in Piwi — Run #{{ run.piwiRunId }}
            </UButton>
          </div>
          <DesktopLocalRunConsole v-if="isExpanded(run)" :lines="run.lines" class="mt-2" />
        </article>
      </div>
    </section>
  </Teleport>
</template>
