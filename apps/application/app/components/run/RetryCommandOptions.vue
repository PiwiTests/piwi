<script setup lang="ts">
import { RETRY_OPTION_LIMITS, type RetryMode, type RetryTraceMode } from '~/utils/retry-command';

/**
 * The choices of a Copy retry command: how the tests are named, and the run
 * options. Every Copy retry command of the page reads them, and the browser
 * remembers all but the Playwright project.
 */
const props = withDefaults(
  defineProps<{
    /** The Playwright projects the tests ran in; with more than one, a project can be picked for all of them. */
    projects?: readonly string[];
    /** Whether the menu offers how the tests are named: a run request names them itself. */
    naming?: boolean;
  }>(),
  { projects: () => [], naming: true },
);

const { prefs, project, mode, update } = useRetryOptions();

const MODE_ITEMS: { value: RetryMode; label: string }[] = [
  { value: 'file-line', label: 'File:line' },
  { value: 'grep', label: 'Title (grep)' },
  { value: 'file', label: 'File only' },
];

const TRACE_ITEMS = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'retain-on-failure', label: 'Retain on failure' },
];

const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const REPEAT_ITEMS = range(RETRY_OPTION_LIMITS.repeatEach.min, RETRY_OPTION_LIMITS.repeatEach.max).map((n) => ({
  value: n,
  label: n === 1 ? 'Once' : `×${n}`,
}));
const WORKER_ITEMS = [
  { value: 0, label: "The config's" },
  ...range(RETRY_OPTION_LIMITS.workers.min, RETRY_OPTION_LIMITS.workers.max).map((n) => ({ value: n, label: `${n}` })),
];

const trace = computed({
  get: () => prefs.value.trace ?? 'off',
  set: (value: string) => update({ trace: value === 'off' ? null : (value as RetryTraceMode) }),
});
const repeatEach = computed({
  get: () => prefs.value.repeatEach,
  set: (value: number) => update({ repeatEach: value }),
});
const workers = computed({
  get: () => prefs.value.workers ?? 0,
  set: (value: number) => update({ workers: value || null }),
});
const headed = computed({
  get: () => prefs.value.headed,
  set: (value: boolean) => update({ headed: value }),
});

/** A select item needs a value other than an empty string. */
const OWN_PROJECT = 'each-test-own';
const projectItems = computed(() => [
  { value: OWN_PROJECT, label: "Each test's own" },
  ...(props.projects ?? []).map((p) => ({ value: p, label: p })),
]);
const projectChoice = computed({
  get: () => (project.value && props.projects?.includes(project.value) ? project.value : OWN_PROJECT),
  set: (value: string) => (project.value = value === OWN_PROJECT ? null : value),
});
</script>

<template>
  <div class="p-2 space-y-3 w-64" data-shot="retry-command-options" data-tour="retry-command-options">
    <div v-if="naming" class="space-y-1">
      <p class="text-xs text-muted px-2">Name the tests by</p>
      <button
        v-for="m in MODE_ITEMS"
        :key="m.value"
        type="button"
        class="w-full text-left px-2 py-1 text-sm rounded hover:bg-elevated"
        :class="mode === m.value ? SEGMENTED_SELECTED_CLASS : ''"
        :aria-pressed="mode === m.value"
        @click="mode = m.value"
      >
        {{ m.label }}
      </button>
    </div>
    <div class="space-y-2 px-2" :class="naming ? 'border-t border-default pt-3' : ''">
      <p class="text-xs text-muted inline-flex items-center gap-1">Options <HelpHint topic="run.retryOptions" /></p>
      <div class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
        <span>Headed</span>
        <USwitch v-model="headed" size="sm" aria-label="Headed" />
        <span>Trace</span>
        <USelect v-model="trace" :items="TRACE_ITEMS" size="xs" class="w-full max-w-36" aria-label="Trace" />
        <span>Repeat each</span>
        <USelect
          v-model="repeatEach"
          :items="REPEAT_ITEMS"
          size="xs"
          class="w-full max-w-36"
          aria-label="Repeat each"
        />
        <span>Workers</span>
        <USelect v-model="workers" :items="WORKER_ITEMS" size="xs" class="w-full max-w-36" aria-label="Workers" />
        <template v-if="(projects?.length ?? 0) > 1">
          <span>Project</span>
          <USelect
            v-model="projectChoice"
            :items="projectItems"
            size="xs"
            class="w-full max-w-36"
            aria-label="Project"
          />
        </template>
      </div>
    </div>
  </div>
</template>
