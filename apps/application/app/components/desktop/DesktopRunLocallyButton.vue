<script setup lang="ts">
/**
 * Desktop shell only: split-button entry point to "run these tests locally".
 * The primary segment runs immediately with the project's saved options — or
 * opens the setup dialog while configuration is broken — and doubles as the
 * run's status indicator: while a run is active (or just finished) clicking it
 * opens the runs tray and never stops anything. The chevron menu holds run
 * presets, option toggles and fix-it entries. Renders nothing without the IPC
 * bridge (plain browsers, web deployments), so pages can mount it
 * unconditionally next to the copyable retry command.
 */
import type { DropdownMenuItem } from '@nuxt/ui';
import type { RetryCase } from '~/utils/retry-command';
import type { LocalRunOptions } from '~/utils/local-run-args';

const props = defineProps<{
  projectId?: string | number | null;
  projectLabel?: string | null;
  cases: RetryCase[];
  /** Primary label while idle — entry points like "Reproduce locally". */
  label?: string;
  /**
   * One-off option overrides for runs started from this button (e.g. repeat
   * ×20 with trace). Applied on top of the project's saved options and kept
   * out of its saved defaults.
   */
  presetOptions?: LocalRunOptions;
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

const options = computed(() => ({ ...store.getProjectOptions(props.projectId ?? ''), ...props.presetOptions }));
const contextRun = computed(() => store.latestForProject(props.projectId));
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
const runModeLabel = computed(
  () => LOCAL_RUN_MODE_ITEMS.find((i) => i.value === options.value.runMode)?.label ?? 'Headless',
);

const face = computed(() => {
  const run = contextRun.value;
  if (run && running.value) {
    return {
      label: localRunProgressLabel(run),
      color: 'info' as const,
      icon: undefined,
      tooltip: 'A local run is going — view its output',
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
      icon: passed ? 'i-lucide-check' : 'i-lucide-x',
      tooltip: 'View the run output',
    };
  }
  if (!linked.value) {
    return {
      label: props.label ?? 'Run locally',
      color: 'warning' as const,
      icon: 'i-lucide-monitor-play',
      tooltip: 'Link this project to its local checkout to run tests here',
    };
  }
  return {
    label: props.label ?? 'Run locally',
    color: 'warning' as const,
    icon: 'i-lucide-monitor-play',
    tooltip: `Run ${testsLabel.value} on this machine · ${runModeLabel.value} · in ${link.value?.path}`,
  };
});

function runNow(patch?: LocalRunOptions) {
  if (props.projectId == null) return;
  store.startRun({
    projectId: props.projectId,
    projectLabel: props.projectLabel,
    cases: props.cases,
    options: { ...props.presetOptions, ...patch },
    persistOptions: props.presetOptions ? false : undefined,
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

function saveOption(patch: LocalRunOptions) {
  if (props.projectId != null) store.saveProjectOptions(props.projectId, patch);
}

const REPEAT_CHOICES = [1, 5, 10, 20, 50, 100];

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
      { type: 'label', label: `Run ${testsLabel.value}` },
      ...LOCAL_RUN_MODE_ITEMS.map((mode) => ({
        label: mode.label,
        icon: mode.icon,
        type: 'checkbox' as const,
        checked: options.value.runMode === mode.value,
        disabled: running.value,
        onSelect: () => runNow({ runMode: mode.value }),
      })),
    ]);

    groups.push([
      {
        label: 'Record trace',
        icon: 'i-lucide-film',
        type: 'checkbox',
        checked: options.value.trace,
        onSelect: (e: Event) => {
          e.preventDefault();
          saveOption({ trace: !options.value.trace });
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
            saveOption({ repeatEach: n });
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
            saveOption({ mode: mode.value });
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
          variant="subtle"
          :icon="face.icon"
          :loading="running"
          :disabled="busy"
          @click="onPrimaryClick"
        >
          {{ face.label }}
        </UButton>
      </UTooltip>
      <UDropdownMenu :items="menuItems" :content="{ align: 'end' }" :ui="{ content: 'min-w-56' }">
        <UButton
          size="xs"
          :color="face.color"
          variant="subtle"
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
    />
  </span>
</template>
