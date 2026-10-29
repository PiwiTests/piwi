<script setup lang="ts">
/**
 * Desktop shell only: split-button entry point to "run these tests locally".
 * The primary segment says what it runs (`label`, plus the options that are not
 * Playwright's defaults: `· headed · ×20 · trace`) and runs it at once, or
 * opens the setup dialog while configuration is broken. It doubles as the
 * status of a run of these same tests: while one is active (or just finished)
 * clicking it opens the runs tray and never stops anything. The chevron menu
 * shows the exact command and holds one-off runs, the other test sets of the
 * page, option toggles and fix-it entries. The options start from the
 * project's defaults (its Local folder settings) and the button's preset; a
 * choice here applies to this button only. Renders nothing without the IPC
 * bridge (plain browsers, web deployments), so pages can mount it
 * unconditionally next to the copyable retry command.
 */
import type { DropdownMenuItem } from '@nuxt/ui';
import type { RetryCase } from '~/utils/retry-command';
import { buildLocalRunPlan, type LocalRunOptions } from '~/utils/local-run-args';
import type { LocalRunSet } from '~/composables/useDesktopLocalRuns';

const props = defineProps<{
  projectId?: string | number | null;
  projectLabel?: string | null;
  cases: RetryCase[];
  /** What the button runs, as its face says it ("Re-run 3 failed tests"); defaults to "Run N tests locally". */
  label?: string;
  /** What the Local runs tray calls a run started here ("Failed tests of run #42"); defaults to the cases. */
  runTitle?: string | null;
  /** Options the button starts with on top of the project's defaults (e.g. repeat ×20 with trace). */
  presetOptions?: LocalRunOptions;
  /** The page's primary action: the idle face takes the accent color. */
  primary?: boolean;
  /** The Piwi run the cases come from: the Local runs tray compares the run's results with it. */
  sourceRunId?: number | null;
  /** Other sets of tests of the page the menu runs instead ("Re-run all 12 tests"), each once. */
  otherSets?: LocalRunSet[];
}>();

const available = ref(false);
onMounted(() => {
  available.value = !!tauriCore();
});

const store = useDesktopLocalRuns();
const { link, busy, pickAndLink, refresh } = useDesktopProjectLink(() => props.projectId);
const { missingSpecs, wrongFolder, checkSpecs } = useDesktopSpecCheck(
  () => props.projectId,
  () => props.cases,
);
const { playwrightMissing, checkEnv } = useDesktopEnvCheck(() => props.projectId);
const { copy } = useCopy();

const modalOpen = ref(false);
// The dialog holds its own link instance; picking a folder there must reflect
// on the button once it closes.
watch(modalOpen, (isOpen) => {
  if (!isOpen) void refresh();
});

const canRun = computed(() => available.value && props.projectId != null && props.cases.length > 0);
const linked = computed(() => !!link.value?.exists);
const attention = computed(() => !linked.value || wrongFolder.value || playwrightMissing.value);

watch([available, () => link.value?.path, linked], () => {
  if (!available.value) return;
  void checkSpecs(linked.value);
  void checkEnv();
});

/** The button's own options, on top of the project's defaults: its menu and its dialog edit these. */
const overrides = ref<LocalRunOptions>({ ...props.presetOptions });
// A page may pass a fresh preset object on each render: only a change of its values resets the button's options.
watch(
  () => JSON.stringify(props.presetOptions ?? null),
  () => {
    overrides.value = { ...props.presetOptions };
  },
);

const options = computed(() => ({ ...store.getProjectOptions(props.projectId ?? ''), ...overrides.value }));
const plan = computed(() => buildLocalRunPlan(props.cases, options.value));
const contextRun = computed(() => store.latestForCases(props.projectId, props.cases));
const running = computed(() => contextRun.value?.status === 'running');

/** Keep the result on the button for a moment after the run ends. */
const FLASH_MS = 8000;
const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });
const flashRun = computed(() => {
  const run = contextRun.value;
  if (!run || !run.finishedAt || (run.status !== 'passed' && run.status !== 'failed')) return null;
  return now.value - run.finishedAt < FLASH_MS ? run : null;
});

const testsLabel = computed(() => `${props.cases.length} test${props.cases.length === 1 ? '' : 's'}`);
const idleLabel = computed(() => props.label ?? `Run ${testsLabel.value} locally`);
const runModeLabel = computed(
  () => LOCAL_RUN_MODE_ITEMS.find((i) => i.value === options.value.runMode)?.label ?? 'Headless',
);
/** The options a run from here takes that are not the defaults, as the face appends them. */
const optionsSuffix = computed(() => localRunOptionsSummary(options.value));

const face = computed(() => {
  const run = contextRun.value;
  if (run && running.value) {
    return {
      label: localRunProgressLabel(run),
      color: 'info' as const,
      variant: 'subtle' as const,
      icon: undefined,
      tooltip: 'A local run of these tests is going — view its output',
    };
  }
  if (flashRun.value) {
    const passed = flashRun.value.status === 'passed';
    return {
      label: passed
        ? 'Passed'
        : flashRun.value.exitCode != null
          ? `Failed (exit ${flashRun.value.exitCode})`
          : 'Failed',
      color: passed ? ('success' as const) : ('error' as const),
      variant: 'subtle' as const,
      icon: passed ? 'i-lucide-check' : 'i-lucide-x',
      tooltip: 'View the run output',
    };
  }
  const idle = {
    label: optionsSuffix.value ? `${idleLabel.value} · ${optionsSuffix.value}` : idleLabel.value,
    color: props.primary ? ('primary' as const) : ('neutral' as const),
    variant: props.primary ? ('solid' as const) : ('outline' as const),
    icon: 'i-lucide-play',
  };
  if (!linked.value) {
    return { ...idle, tooltip: 'Link this project to its local checkout to run tests here' };
  }
  const command = plan.value.length === 1 ? plan.value[0]!.display : `${plan.value.length} commands, one per project`;
  return {
    ...idle,
    tooltip: `${command} · ${runModeLabel.value} · in ${link.value?.path}`,
  };
});

function runNow(patch?: LocalRunOptions, set?: LocalRunSet) {
  if (props.projectId == null) return;
  store.startRun({
    projectId: props.projectId,
    projectLabel: props.projectLabel,
    cases: set?.cases ?? props.cases,
    title: set ? set.runTitle : props.runTitle,
    sourceRunId: props.sourceRunId,
    options: { ...overrides.value, ...patch },
  });
}

function onPrimaryClick() {
  if (running.value || flashRun.value) {
    store.trayOpen.value = true;
    return;
  }
  if (attention.value) {
    modalOpen.value = true;
    return;
  }
  runNow();
}

function setOption(patch: LocalRunOptions) {
  overrides.value = { ...overrides.value, ...patch };
}

const REPEAT_CHOICES = [1, 5, 10, 20, 50, 100];

/** The commands a run from here spawns, at most four, as the menu shows them. */
const MAX_PREVIEW_STEPS = 4;
const commandPreview = computed(() => {
  const shown = plan.value.slice(0, MAX_PREVIEW_STEPS).map((step) => step.display);
  const more = plan.value.length - shown.length;
  return more > 0 ? [...shown, `… and ${more} more`].join('\n') : shown.join('\n');
});

const menuItems = computed<DropdownMenuItem[][]>(() => {
  const groups: DropdownMenuItem[][] = [];

  if (!linked.value) {
    groups.push([
      { type: 'label', label: link.value ? 'The linked folder is missing' : 'No folder linked yet' },
      { label: 'Choose folder…', icon: 'i-lucide-folder-plus', onSelect: () => void pickAndLink() },
    ]);
  } else if (wrongFolder.value) {
    groups.push([
      { type: 'label', label: 'Tests not found in the linked folder' },
      { label: 'Choose the right folder…', icon: 'i-lucide-folder-search', onSelect: () => void pickAndLink() },
      { label: 'Run anyway', icon: 'i-lucide-play', onSelect: () => runNow() },
    ]);
  } else if (playwrightMissing.value) {
    groups.push([
      { type: 'label', label: 'No Playwright found in the linked folder' },
      {
        label: 'Re-check after installing',
        icon: 'i-lucide-refresh-cw',
        onSelect: (e: Event) => {
          e.preventDefault();
          void checkEnv();
        },
      },
      { label: 'Run anyway', icon: 'i-lucide-play', onSelect: () => runNow() },
    ]);
  }

  if (linked.value) {
    groups.push([
      { type: 'label', label: plan.value.length === 1 ? 'Runs this command' : 'Runs these commands, one by one' },
      {
        type: 'label',
        label: commandPreview.value,
        class: 'font-mono text-[11px] font-normal',
        ui: { itemLabel: 'whitespace-pre-wrap! break-all' },
      },
    ]);

    groups.push([
      { type: 'label', label: 'Run once' },
      ...LOCAL_RUN_MODE_ITEMS.map((mode) => ({
        label: mode.label,
        icon: mode.icon,
        type: 'checkbox' as const,
        checked: options.value.runMode === mode.value,
        disabled: running.value,
        onSelect: () => runNow({ runMode: mode.value }),
      })),
    ]);

    const sets = (props.otherSets ?? []).filter((set) => set.cases.length > 0);
    if (sets.length > 0) {
      groups.push([
        { type: 'label', label: 'Run other tests' },
        ...sets.map((set) => ({
          label: set.label,
          icon: 'i-lucide-list-checks',
          onSelect: () => runNow(undefined, set),
        })),
      ]);
    }

    groups.push([
      { type: 'label', label: 'Options of this button' },
      {
        label: 'Record trace',
        icon: 'i-lucide-film',
        type: 'checkbox',
        checked: options.value.trace,
        onSelect: (e: Event) => {
          e.preventDefault();
          setOption({ trace: !options.value.trace });
        },
      },
      {
        label: `Repeat each (× ${options.value.repeatEach})`,
        icon: 'i-lucide-repeat',
        children: REPEAT_CHOICES.map((n) => ({
          label: `× ${n}`,
          type: 'checkbox' as const,
          checked: options.value.repeatEach === n,
          onSelect: (e: Event) => {
            e.preventDefault();
            setOption({ repeatEach: n });
          },
        })),
      },
      {
        label: 'Select tests by',
        icon: 'i-lucide-list-filter',
        children: RETRY_MODE_ITEMS.map((mode) => ({
          label: mode.label,
          type: 'checkbox' as const,
          checked: options.value.mode === mode.value,
          onSelect: (e: Event) => {
            e.preventDefault();
            setOption({ mode: mode.value });
          },
        })),
      },
    ]);

    groups.push([
      { label: 'Run with options…', icon: 'i-lucide-sliders-horizontal', onSelect: () => (modalOpen.value = true) },
      {
        label: 'Copy as command',
        icon: 'i-lucide-clipboard',
        onSelect: () =>
          void copy(buildRetryCommand(props.cases, { mode: options.value.mode }), { toast: 'Command copied' }),
      },
      {
        label: 'Project defaults…',
        icon: 'i-lucide-settings-2',
        to: `/projects/${props.projectId}?tab=settings&section=local-folder`,
      },
    ]);
  }

  groups.push([
    {
      label: store.activeCount.value > 0 ? `Local runs (${store.activeCount.value} active)` : 'Local runs',
      icon: 'i-lucide-terminal',
      onSelect: () => (store.trayOpen.value = true),
    },
  ]);

  if (linked.value && !wrongFolder.value && missingSpecs.value.length > 0) {
    groups[groups.length - 1]!.unshift({
      type: 'label',
      label: `${missingSpecs.value.length} spec${missingSpecs.value.length === 1 ? '' : 's'} not in the linked folder`,
    });
  }

  if (linked.value) {
    groups.push([
      { type: 'label', label: link.value!.path, class: 'font-mono text-[11px] break-all font-normal' },
      { label: 'Change linked folder…', icon: 'i-lucide-folder-search', onSelect: () => void pickAndLink() },
    ]);
  }

  return groups;
});
</script>

<template>
  <span v-if="canRun" class="inline-flex">
    <UFieldGroup size="xs">
      <UTooltip :text="face.tooltip">
        <UButton
          size="xs"
          :color="face.color"
          :variant="face.variant"
          :icon="face.icon"
          :loading="running"
          :disabled="busy"
          @click="onPrimaryClick"
        >
          {{ face.label }}
        </UButton>
      </UTooltip>
      <UDropdownMenu :items="menuItems" :content="{ align: 'end' }" :ui="{ content: 'min-w-56 max-w-md' }">
        <UButton
          size="xs"
          :color="face.color"
          :variant="face.variant"
          icon="i-lucide-chevron-down"
          aria-label="Run options"
          class="relative"
        >
          <span v-if="attention" class="absolute -top-1 -right-1 size-2 rounded-full bg-warning" />
        </UButton>
      </UDropdownMenu>
    </UFieldGroup>
    <DesktopRunLocallyModal
      v-model:open="modalOpen"
      :project-id="projectId!"
      :project-label="projectLabel"
      :cases="cases"
      :label="idleLabel"
      :run-title="runTitle"
      :source-run-id="sourceRunId"
      v-model:options="overrides"
    />
  </span>
</template>
