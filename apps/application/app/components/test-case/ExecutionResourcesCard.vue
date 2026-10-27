<script setup lang="ts">
/**
 * What one execution cost, as its worker measured it at the end of the test:
 * the CPU of the worker and of the browser processes it started, the largest
 * of those processes, the worker's event loop, the pages already open when the
 * test started and what it left open, and the artifacts it wrote.
 */
import type { WireExecutionResources } from '#shared/types';
import type { HelpTopicKey } from '~/utils/help-content';
import { browserCpuMs, peakRssMb } from '#shared/resource-report';
import { formatCpuTime, formatSize } from '#shared/resource-copy';
import { executionRoleFacts } from '~/utils/resources';

const props = defineProps<{
  resources: WireExecutionResources;
  help?: HelpTopicKey;
  /** Drop the card frame and padding — render a plain heading row over the body. */
  embedded?: boolean;
}>();

const browserCpu = computed(() => browserCpuMs(props.resources));
const peak = computed(() => peakRssMb(props.resources));
const roles = computed(() => executionRoleFacts(props.resources));
const artifacts = computed(() => {
  const bytes = Object.values(props.resources.artifactBytes ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  return bytes > 0 ? formatSize(bytes) : null;
});
const openAtStart = computed(() => props.resources.openAtStart ?? null);
</script>

<template>
  <SectionCard
    title="What the test cost"
    :icon="embedded ? undefined : 'i-lucide-cpu'"
    :help="help"
    :embedded="embedded"
    data-shot="execution-resources"
    data-tour="execution-resources"
  >
    <div class="space-y-3">
      <StatTileGrid min-tile-width="9rem">
        <StatTile
          label="CPU"
          :value="formatCpuTime(resources.workerCpuMs + (browserCpu ?? 0))"
          :hint="browserCpu !== null ? 'worker and browser' : 'worker'"
        />
        <StatTile
          v-if="peak !== null"
          label="Largest browser process"
          :value="formatSize(peak * 1024 * 1024)"
          hint="resident memory"
        />
        <StatTile
          label="Event loop"
          :value="`${Math.round(resources.loopUtilization * 100)}% busy`"
          :hint="`p99 delay ${Math.round(resources.loopDelayP99Ms)} ms`"
        />
        <StatTile
          v-if="openAtStart"
          label="Open at start"
          :value="`${openAtStart.pages} page${openAtStart.pages === 1 ? '' : 's'}`"
          :hint="`${openAtStart.contexts} context${openAtStart.contexts === 1 ? '' : 's'}`"
        />
        <StatTile
          v-if="resources.leftOpen !== null && resources.leftOpen !== undefined"
          label="Left open"
          :value="resources.leftOpen"
          hint="opened by this test"
        />
      </StatTileGrid>
      <p class="text-xs text-muted break-words">
        Worker {{ formatCpuTime(resources.workerCpuMs) }}
        <template v-if="roles.length"> · {{ roles.join(' · ') }}</template>
        · heap {{ Math.round(resources.heapUsedMb) }} MB
        <template v-if="resources.involuntarySwitches">
          · {{ resources.involuntarySwitches.toLocaleString('en-US') }} involuntary context switches</template
        >
        <template v-if="artifacts"> · {{ artifacts }} of artifacts</template>
      </p>
    </div>
  </SectionCard>
</template>
