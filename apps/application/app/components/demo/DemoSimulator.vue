<script setup lang="ts">
import type { DemoScenario } from '~/demo/simulator';

/**
 * Scenario launcher for the demo run simulator, rendered inside the demo banner. Lets visitors replay different kinds
 * of live test runs as if a Piwi reporter were streaming them in (see app/demo/simulator.ts). The scenarios open in a
 * popover from `sm` up and in a sheet from the bottom of the screen on a phone; while one runs, its progress takes the
 * button's place, on a row of its own on a phone.
 */

const { state, scenarios, start, stop, cancelStaleRuns, runPath } = useDemoSimulator();

// Demo DB readiness — flipped once the service worker answers its first query (demo-fetch plugin)
const demoReady = useState('demoReady', () => false);

/** From `sm` up the scenarios open in a popover under the button; below, in a sheet. */
const wide = useMediaQuery('(min-width: 640px)');
const pickerOpen = ref(false);

const INTRO = 'Watch a live run arrive, as if a Piwi reporter were streaming it from CI.';

onMounted(() => {
  // Clean up runs orphaned by a reload mid-simulation. $fetch waits for the
  // service worker to claim the page, so this is safe to call right away.
  cancelStaleRuns();
});

function launch(scenario: DemoScenario) {
  pickerOpen.value = false;
  start(scenario);
}
</script>

<template>
  <div
    class="flex min-w-0 items-center gap-2"
    :class="state.status === 'idle' ? '' : 'max-sm:order-last max-sm:basis-full max-sm:justify-between'"
    data-tour="demo-simulator"
  >
    <template v-if="state.status === 'idle'">
      <UPopover
        v-if="wide"
        v-model:open="pickerOpen"
        :content="{ align: 'end', collisionPadding: 8 }"
        :ui="{ content: 'z-[70]' }"
      >
        <UButton
          size="xs"
          color="warning"
          variant="solid"
          icon="i-lucide-radio-tower"
          trailing-icon="i-lucide-chevron-down"
          label="Simulate a test run"
          :disabled="!demoReady"
        />

        <template #content>
          <div
            class="max-h-(--reka-popover-content-available-height) w-[min(40rem,calc(100vw-1rem))] overflow-y-auto p-2"
            data-shot="demo-simulator-menu"
          >
            <p class="px-2 pb-2 text-xs text-muted">{{ INTRO }}</p>
            <DemoScenarioList :scenarios="scenarios" columns @pick="launch" />
          </div>
        </template>
      </UPopover>

      <!-- Above the demo banner (z-index 60), like its other menus. -->
      <UDrawer
        v-else
        v-model:open="pickerOpen"
        title="Simulate a test run"
        :description="INTRO"
        :ui="{ overlay: 'z-[70]', content: 'z-[70] max-h-[85dvh]', container: 'gap-3', header: 'shrink-0' }"
      >
        <UButton
          size="xs"
          color="warning"
          variant="solid"
          icon="i-lucide-radio-tower"
          aria-label="Simulate a test run"
          label="Simulate"
          :disabled="!demoReady"
        />

        <template #body>
          <div data-shot="demo-simulator-sheet">
            <DemoScenarioList :scenarios="scenarios" @pick="launch" />
          </div>
        </template>
      </UDrawer>
    </template>

    <template v-else>
      <div class="flex min-w-0 items-center gap-2">
        <UIcon name="i-lucide-loader-circle" class="size-4 shrink-0 animate-spin" />
        <span class="min-w-0 truncate text-sm">{{ state.scenario?.label }}</span>
        <span class="shrink-0 text-sm whitespace-nowrap tabular-nums">
          <template v-if="state.total > 0">
            {{ state.completed }}/{{ state.total }}<span class="max-sm:hidden"> tests</span>
          </template>
          <template v-else>starting…</template>
        </span>
        <UBadge v-if="state.failed > 0" color="error" variant="subtle" size="sm" class="shrink-0 whitespace-nowrap">
          {{ state.failed }} failed
        </UBadge>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <UButton
          v-if="state.runId"
          size="xs"
          color="warning"
          variant="solid"
          icon="i-lucide-eye"
          aria-label="View run"
          :to="runPath(state.runId, state.scenario)"
        >
          <span class="max-sm:hidden">View run</span>
        </UButton>
        <UButton
          size="xs"
          color="warning"
          variant="outline"
          icon="i-lucide-square"
          label="Stop"
          :loading="state.status === 'stopping'"
          @click="stop"
        />
      </div>
    </template>
  </div>
</template>
