<script setup lang="ts">
/**
 * Map health — how much of the Test Map's input a project sends, one row per
 * optional input: what it holds against what it could, the detectors it wakes,
 * and the setup step behind it when it is short. A quiet Gaps view then reads as
 * either a covered application or a map that cannot see yet.
 */
import { docsUrl } from '#shared/docs';
import { errorMessage } from '~/utils';

interface HealthRow {
  id: string;
  have: number;
  of: number | null;
  wakes: string[];
  ranks?: boolean;
}

/** What each input is, how its numbers read, and the step that fills it. */
const COPY: Record<string, { label: string; unit: string; empty: string; setup: string; doc: string }> = {
  inventory: {
    label: 'Page inventory',
    unit: 'reached pages hold an inventory',
    empty: 'No page is reached yet.',
    setup:
      'Turn on capturePageInventory in the reporter: each page a passing run visits records its controls and links.',
    doc: 'features/scenario-gaps#what-feeds-the-map',
  },
  'locator-pages': {
    label: 'Locator pages',
    unit: 'tests name the page each locator call runs on',
    empty: 'No locator call is indexed yet.',
    setup: 'Import test from the capture fixtures in every spec: they record the page each locator call runs on.',
    doc: 'guide/capture-fixtures',
  },
  handlers: {
    label: 'Handlers',
    unit: 'observed routes have a handler',
    empty: 'No route is observed yet.',
    setup: 'Add the backend instrumentation: its server spans name the handler behind each route and what it calls.',
    doc: 'guide/backend-logs#server-spans',
  },
  probes: {
    label: 'Probes',
    unit: 'reached routes were probed',
    empty: 'No route is reached yet.',
    setup: 'Run piwi probe on a schedule: it breaks a response and records whether the test noticed.',
    doc: 'features/probes',
  },
  declared: {
    label: 'Declared surface',
    unit: 'declared routes and pages',
    empty: '',
    setup: 'Upload a route manifest, or set an OpenAPI URL in the project’s Scenario gaps settings.',
    doc: 'features/scenario-gaps#declared-surface',
  },
  changes: {
    label: 'Change history',
    unit: 'commits with their changed files',
    empty: '',
    setup: 'Connect the repository host, so each run records the files its diff changed.',
    doc: 'guide/source-control',
  },
  catalog: {
    label: 'Function catalog',
    unit: 'page-object methods and helpers',
    empty: '',
    setup: 'Add your page objects to the test functions catalog.',
    doc: 'features/test-functions',
  },
};

const props = defineProps<{ projectId: number }>();

const rows = ref<HealthRow[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

let requestToken = 0;
async function load() {
  const token = ++requestToken;
  loading.value = true;
  try {
    const res = await $fetch<{ items: HealthRow[] }>(
      `/api/projects/${props.projectId}/gaps/health` as `/api/projects/:id/gaps/health`,
    );
    if (token !== requestToken) return;
    rows.value = res.items ?? [];
    loadError.value = null;
  } catch (err) {
    if (token === requestToken) {
      rows.value = [];
      loadError.value = errorMessage(err);
    }
  } finally {
    if (token === requestToken) loading.value = false;
  }
}

watch(() => props.projectId, load, { immediate: true });

type RowState = 'full' | 'partial' | 'missing' | 'idle';

/** Full when every candidate has the input, idle when there is nothing to measure yet. */
function stateOf(row: HealthRow): RowState {
  if (row.of === null) return row.have > 0 ? 'full' : 'missing';
  if (row.of === 0) return 'idle';
  if (row.have >= row.of) return 'full';
  return row.have === 0 ? 'missing' : 'partial';
}

const STATE_ICON: Record<RowState, { icon: string; class: string; label: string }> = {
  full: { icon: 'i-lucide-circle-check', class: 'text-success', label: 'Complete' },
  partial: { icon: 'i-lucide-circle-dot', class: 'text-warning', label: 'Partial' },
  missing: { icon: 'i-lucide-circle-dashed', class: 'text-muted', label: 'Missing' },
  idle: { icon: 'i-lucide-circle', class: 'text-dimmed', label: 'Nothing to measure yet' },
};

function valueLine(row: HealthRow): string {
  const copy = COPY[row.id];
  if (row.of === null) return `${row.have} ${copy?.unit ?? ''}`;
  if (row.of === 0) return copy?.empty ?? '';
  return `${row.have} of ${row.of} ${copy?.unit ?? ''}`;
}

const detectorLabel = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replaceAll('-', ' ');

/** The inputs every candidate has, for the header line. */
const fullCount = computed(() => rows.value.filter((r) => stateOf(r) === 'full').length);
</script>

<template>
  <div data-shot="map-health">
    <ErrorState v-if="loadError" :text="`Couldn't load map health: ${loadError}`">
      <template #action>
        <UButton size="xs" color="neutral" variant="outline" label="Retry" @click="load" />
      </template>
    </ErrorState>
    <LoadingState v-else-if="loading && rows.length === 0" />
    <template v-else>
      <p class="text-xs text-muted">{{ fullCount }} of {{ rows.length }} inputs are complete.</p>
      <ul class="mt-2 divide-y divide-default">
        <li v-for="row in rows" :key="row.id" class="py-2.5 flex gap-3" :data-shot="`map-health-${row.id}`">
          <span role="img" :aria-label="STATE_ICON[stateOf(row)].label" class="mt-0.5 shrink-0">
            <UIcon :name="STATE_ICON[stateOf(row)].icon" :class="['size-4 block', STATE_ICON[stateOf(row)].class]" />
          </span>
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span class="text-sm font-medium text-highlighted">{{ COPY[row.id]?.label ?? row.id }}</span>
              <span class="text-xs text-muted tabular-nums">{{ valueLine(row) }}</span>
            </div>
            <div
              v-if="row.of !== null && row.of > 0"
              class="h-1 rounded-full bg-elevated overflow-hidden"
              role="presentation"
            >
              <div
                class="h-full rounded-full bg-primary"
                :style="{ width: `${Math.round((row.have / row.of) * 100)}%` }"
              />
            </div>
            <p v-if="stateOf(row) === 'partial' || stateOf(row) === 'missing'" class="text-xs text-default">
              {{ COPY[row.id]?.setup }}
              <ULink
                v-if="COPY[row.id]"
                :to="docsUrl(COPY[row.id]!.doc)"
                target="_blank"
                class="text-primary hover:underline"
                >How</ULink
              >
            </p>
            <p class="text-xs text-muted">
              Wakes {{ row.wakes.map(detectorLabel).join(', ')
              }}<span v-if="row.ranks">, and ranks gaps by the churn and escapes of their files</span>.
            </p>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
