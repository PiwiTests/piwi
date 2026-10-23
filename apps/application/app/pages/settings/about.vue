<script setup lang="ts">
import type { ApiResponse } from '~~/types/api';
const config = useRuntimeConfig();
const isDesktop = useIsDesktop();

const { data: versionInfo } =
  await useFetch<ApiResponse<typeof import('~~/server/api/version.get').default>>('/api/version');

// The detector-precision block follows the instance `test-map` state: an
// instance that declined it hides the block and never fetches it.
const { isHidden: instCapHidden } = await useInstanceCapabilities();
const precisionHidden = computed(() => instCapHidden('test-map'));

// Scenario-gap detector precision from triage verdicts, per detector per project.
interface DetectorPrecisionRow {
  detector: string;
  for: number;
  against: number;
  verdicts: number;
  precision: number | null;
  muted: boolean;
}
// Lazy so the precision query never blocks the About page's first paint.
const { data: precisionProjects } = useFetch('/api/gaps/precision', {
  lazy: true,
  immediate: !precisionHidden.value,
  default: () => [] as Array<{ projectId: number; projectName: string; detectors: DetectorPrecisionRow[] }>,
  transform: (r: { items: Array<{ projectId: number; projectName: string; detectors: DetectorPrecisionRow[] }> }) =>
    r.items,
});

const appVersion = config.public.appVersion as string;
const buildSha = config.public.buildSha as string;
const buildTime = config.public.buildTime as string;
const nodeVersion = config.public.nodeVersion as string;
const authEnabled = config.public.authEnabled as boolean;

const shortSha = computed(() => (buildSha ? buildSha.slice(0, 7) : null));

const dbBackendLabel = computed(() => {
  const backend = versionInfo.value?.dbBackend;
  if (backend === 'postgresql') return 'PostgreSQL';
  if (backend === 'sqlite') return 'SQLite';
  return backend ?? null;
});
</script>

<template>
  <div class="space-y-6">
    <!-- Header: the brand mark with the version and build date beside it on
         desktop, stacked and centered on phones. -->
    <div
      class="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-center sm:justify-between sm:text-left"
      data-tour="about-page"
    >
      <BrandLogo class="h-14 sm:h-16" />
      <div class="text-sm text-muted">
        <p>
          <span class="font-mono text-highlighted">v{{ appVersion }}</span>
          <template v-if="shortSha">
            ·
            <span class="font-mono" :title="buildSha">{{ shortSha }}</span>
          </template>
        </p>
        <p v-if="buildTime" class="mt-0.5">
          <ClientOnly fallback-tag="span" :fallback="`Built ${formatRelativeTime(buildTime)}`">
            <span :title="prettyDateFormat(buildTime)">Built {{ formatRelativeTime(buildTime) }}</span>
          </ClientOnly>
        </p>
      </div>
    </div>

    <SectionCard icon="i-lucide-info" title="Application">
      <StatTileGrid>
        <StatTile label="Node.js" :value="nodeVersion" />
        <StatTile label="Database" :value="dbBackendLabel" />
        <StatTile label="Authentication" :value="authEnabled ? 'Enabled' : 'Disabled'" />
      </StatTileGrid>
    </SectionCard>

    <SectionCard
      v-if="!precisionHidden && precisionProjects.length > 0"
      icon="i-lucide-target"
      title="Scenario-gap detector precision"
    >
      <p class="mb-3 text-sm text-muted">
        From triage verdicts: accepted and covered-by count for a detector, dismissed-as-wrong against. A detector below
        60% over 20+ verdicts mutes itself on that project and drops out of the PR comment first.
      </p>
      <div v-for="proj in precisionProjects" :key="proj.projectId" class="mb-4">
        <p class="text-xs font-medium text-muted">{{ proj.projectName }}</p>
        <div class="mt-1 divide-y divide-default text-sm">
          <div v-for="d in proj.detectors" :key="d.detector" class="flex items-center gap-3 py-1.5">
            <span class="font-mono text-xs w-56 shrink-0">{{ d.detector }}</span>
            <span class="tabular-nums w-16 text-right">{{
              d.precision != null ? `${Math.round(d.precision * 100)}%` : '—'
            }}</span>
            <span class="text-xs text-muted">{{ d.for }} for · {{ d.against }} against</span>
            <UBadge v-if="d.muted" color="warning" variant="subtle" size="sm">muted</UBadge>
          </div>
        </div>
      </div>
    </SectionCard>

    <!-- Desktop shell only (renders nothing without the IPC bridge). Updates stay
         here next to the version they act on; connecting the reporter and MCP
         clients moved to /setup, which is where "how do I hook this up" lives. -->
    <DesktopUpdateCard :current-version="appVersion" />

    <UAlert
      v-if="isDesktop"
      icon="i-lucide-rocket"
      color="neutral"
      variant="subtle"
      title="Connecting the reporter and AI clients"
      description="The URL and access token for this local instance, the data location, and background-service control are on the Setup page."
      :actions="[{ label: 'Open Setup', to: '/setup', color: 'neutral', variant: 'solid', size: 'xs' }]"
    />

    <SectionCard icon="i-lucide-book-open" title="Resources">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <DocLink to="">Documentation</DocLink>
        <ULink to="/docs" class="inline-flex items-center gap-1 text-primary hover:underline"> API reference </ULink>
        <ULink
          to="https://github.com/piwitests/platform"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 text-primary hover:underline"
        >
          GitHub
          <UIcon name="i-lucide-external-link" class="w-3.5 h-3.5 shrink-0" />
        </ULink>
      </div>
    </SectionCard>
  </div>
</template>
