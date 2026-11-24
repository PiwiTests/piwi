/**
 * **This computer** in a place's run (`useRunPlace`), in the desktop window only: the place's tests run in the
 * project's linked folder with its own Playwright, through the shell, and stream into the Local runs tray. Nothing of
 * it shows without the IPC bridge (plain browsers, web deployments).
 *
 * The run button's face runs the place's first What here at once while This computer is its Where, and says what it
 * runs (`label`, plus the options that are not Playwright's defaults and the environment: `· headed · ×20 ·
 * Staging`). It doubles as the status of a run of the same tests: while one goes on, or just ended, it shows it, and a
 * click opens the tray, never stopping anything. While the folder needs attention (none linked, the tests not in it,
 * no Playwright), a click opens the run dialog on This computer instead, whose fields hold the fix; while no test has
 * a filter Playwright takes, it opens the menu, which says why nothing runs.
 *
 * The button's menu (`menuGroups`) shows the command (at most four steps, the dialog has it whole) and holds the
 * one-off runs (a browser mode, the place's other Whats), the fix-it entries, the options of the button, Run with
 * options…, Copy as command and the linked folder. The options start from the project's defaults (its Local folder
 * settings), what the tests need (whole files for a large run) and the place's preset; a choice in the menu applies to
 * the place's runs alone. A run of the button is for
 * the environment of the run its tests come from (`environmentId`, else read from `sourceRunId`), unless that one is
 * protected: it then runs for none, and the dialog picks another.
 *
 * The dialog's fields (`RunThisComputerFields`) start from the button's options and apply to the run they start
 * alone; their environment starts on the last one picked for the folder, and a protected one is confirmed for each
 * run (`DesktopEnvironmentField`).
 */
import type { DropdownMenuItem } from '@nuxt/ui';
import type { RunVariable } from '@piwitests/core/run-variables';
import type { EnvironmentForRun } from '@piwitests/core/environments';
import { commandWithEnvironment } from '#shared/run-variables';
import {
  environmentReady,
  pickOf,
  runEnvironmentChoice,
  type DesktopEnvironmentChoice,
} from '#shared/desktop-environments';
import {
  buildLocalRunPlan,
  localRunCopyOptions,
  localRunHoldRefusal,
  localRunHoldsFailures,
  localRunNamedCases,
  type LocalRunOptions,
} from '~/utils/local-run-args';
import type { LocalRunSet, SavedLocalRunOptions } from '~/composables/useDesktopLocalRuns';
import type { RunWhereRow } from '~/composables/useRunPlace';
import { DESKTOP_APP_NAME } from '#shared/piwi-ecosystem';
import type { DesktopRunSettings } from '~/composables/useDesktopEnvironments';

/** What a place's runs on this computer share, beside each What's tests (`RunWhat.local`). */
export interface ThisComputerPlace {
  projectLabel?: () => string | null | undefined;
  /** The Piwi run the tests come from: the Local runs tray compares a run's results with it. */
  sourceRunId?: () => number | null | undefined;
  /** The environment of the run the tests come from; read from `sourceRunId` when not given. */
  environmentId?: () => number | null;
  /** Options the button starts with on top of the project's defaults (a test's ×20 with a trace). */
  presetOptions?: LocalRunOptions;
}

/** A What's run on this computer, or a reason it has none. */
export type ThisComputerWhat = LocalRunSet | { reason: string } | null | undefined;

/** The What's tests to run here, or null when This computer does not run it. */
export function localSetOf(local: ThisComputerWhat): LocalRunSet | null {
  return local && 'cases' in local && local.cases.length > 0 ? local : null;
}

/** The run button's face: what it says and how it looks. */
export interface ThisComputerFace {
  label: string;
  color: 'primary' | 'neutral' | 'info' | 'success' | 'error';
  variant: 'solid' | 'outline' | 'subtle';
  icon?: string;
  /** The icon turns: a run of these tests goes on. */
  spinning?: boolean;
  tooltip: string;
  /** A run of these tests goes on or just ended: a click opens the Local runs tray. */
  status: boolean;
}

/** Keep the result on the button for a moment after the run ends. */
const FLASH_MS = 8000;
const REPEAT_CHOICES = [1, 5, 10, 20, 50, 100];
/** The commands a run from the button spawns that its menu shows, each cut short. */
const MAX_PREVIEW_STEPS = 4;

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

export function useThisComputer(input: {
  projectId: number;
  place: ThisComputerPlace | undefined;
  /** The place's first What's tests: what the button's face runs. */
  main: () => LocalRunSet | null;
  /** The place's other Whats' tests, which the menu runs once. */
  others: () => LocalRunSet[];
  /** Some What of the place runs here, or says why it does not: This computer is read only then. */
  offered: () => boolean;
  /** Hears each run started here, so the place keeps This computer as its last Where. */
  onRun: () => void;
}) {
  const place = input.place ?? {};
  const available = ref(false);
  onMounted(() => {
    available.value = !!tauriCore();
  });
  /** The window has the bridge and the place offers This computer: the folder, the checks and the environments are read. */
  const active = computed(() => available.value && input.offered());
  const projectId = computed(() => (active.value && input.projectId ? input.projectId : null));
  const projectLabel = () => place.projectLabel?.() ?? null;
  const sourceRunId = () => place.sourceRunId?.() ?? null;

  const main = computed(() => input.main());
  const cases = computed(() => main.value?.cases ?? []);
  /** The button's face runs tests here: the window has the bridge and the place's first What runs here. */
  const takesMain = computed(() => available.value && main.value != null);

  const store = useDesktopLocalRuns();
  const { link, loaded: linkLoaded, busy, pickAndLink, refresh } = useDesktopProjectLink(projectId);
  const { specFiles, missingSpecs, wrongFolder, checkSpecs } = useDesktopSpecCheck(projectId, cases);
  const { playwrightMissing, checkEnv } = useDesktopEnvCheck(projectId);
  const { copy } = useCopy();

  const linked = computed(() => !!link.value?.exists);
  /** The folder needs a fix before a run: the menu and the dialog hold it. */
  const attention = computed(() => !linked.value || wrongFolder.value || playwrightMissing.value);

  watch([active, () => link.value?.path, linked], () => {
    if (!active.value) return;
    void checkSpecs(linked.value);
    void checkEnv();
  });
  // A selection's cases change with each click: its spec check follows them.
  watch(
    () => [...new Set(cases.value.map((c) => c.filePath))].sort().join('\n'),
    () => {
      if (active.value) void checkSpecs(linked.value);
    },
  );

  /** Link the project's folder, checked against the tests the button runs. */
  function chooseFolder(specs = specFiles.value) {
    void pickAndLink({ projectLabel: projectLabel(), specs });
  }

  // ── The button's options ──────────────────────────────────────────────────
  /**
   * The button's own options, on top of the project's defaults and of the options its tests need (whole files for a
   * large run): its menu edits these, the dialog starts from them.
   */
  const overrides = ref<LocalRunOptions>({ ...place.presetOptions });
  /** What a run of `set` takes on top of the project's defaults: another set's own options win over the button's. */
  function runOptions(set: LocalRunSet | null, main: boolean): LocalRunOptions {
    return main ? { ...set?.options, ...overrides.value } : { ...overrides.value, ...set?.options };
  }
  const options = computed(() => ({
    ...store.getProjectOptions(input.projectId),
    ...runOptions(main.value, true),
  }));
  function setOption(patch: LocalRunOptions) {
    overrides.value = { ...overrides.value, ...patch };
  }

  // ── The environment a run of the button is for ────────────────────────────
  /** The environment of the run the tests come from, as the page names it or the run reported it. */
  const sourceEnvironmentId = ref<number | null>(null);
  watch(
    [active, () => place.environmentId?.(), sourceRunId],
    async () => {
      if (place.environmentId) {
        sourceEnvironmentId.value = place.environmentId();
        return;
      }
      sourceEnvironmentId.value = null;
      const runId = sourceRunId();
      if (!active.value || runId == null) return;
      try {
        const reported = await $fetch<{ label: string | null; environmentId: number | null }>(
          `/api/desktop/test-runs/${runId}/environment`,
        );
        if (sourceRunId() === runId) sourceEnvironmentId.value = reported.environmentId;
      } catch {
        // The run is gone or not readable: a run from here is for no environment.
      }
    },
    { immediate: true },
  );
  /**
   * The team project's environments are read only when the source run's environment is one the runs of a team
   * environment discovered in the project, with no run variables of its own: the run then starts on the team one.
   */
  const projectEnvironments = useProjectEnvironments(projectId);
  const sourceIsDiscovered = computed(() => {
    const own = projectEnvironments.byId(sourceEnvironmentId.value);
    return !!own?.discovered && own.runVariables.length === 0;
  });
  const { choices: environmentChoices, loaded: environmentsLoaded } = useDesktopEnvironments(projectId, {
    withTeam: sourceIsDiscovered,
  });
  /** A run from the button waits for the team project's environments it may start on. */
  const environmentsReady = computed(() => !sourceIsDiscovered.value || environmentsLoaded.value);
  /** The environment a run of the button is for: the source run's, unless protected. */
  const runEnvironment = computed(() => runEnvironmentChoice(environmentChoices.value, sourceEnvironmentId.value));

  // ── What the button runs ──────────────────────────────────────────────────
  const plan = computed(() => buildLocalRunPlan(cases.value, options.value));
  /** The cases the plan names; the others have no file path, or no title, Playwright can select them by. */
  const namedCases = computed(() => localRunNamedCases(cases.value, options.value.mode));
  const leftOut = computed(() => cases.value.length - namedCases.value.length);
  /** No case has a filter Playwright can take. */
  const noPlan = computed(() => plan.value.length === 0);
  const noPlanHint = computed(() =>
    options.value.mode === 'grep'
      ? 'These tests have no title to select them by: select them by file'
      : "Playwright cannot take these tests' file paths: select them by title",
  );

  // ── The face ──────────────────────────────────────────────────────────────
  const contextRun = computed(() => store.latestForCases(projectId.value, cases.value));
  const running = computed(() => contextRun.value?.status === 'running');
  const { count: runCount } = useDesktopRunBadge();
  const now = useTimestamp({ scheduler: (update) => useIntervalFn(update, 1000) });
  const flashRun = computed(() => {
    const run = contextRun.value;
    if (!run || !run.finishedAt || (run.status !== 'passed' && run.status !== 'failed')) return null;
    return now.value - run.finishedAt < FLASH_MS ? run : null;
  });

  const runModeLabel = computed(
    () => LOCAL_RUN_MODE_ITEMS.find((i) => i.value === options.value.runMode)?.label ?? 'Headless',
  );
  /** The tests a run from here runs: the cases its plan names, or all of them while it names none. */
  const testCount = computed(() => (noPlan.value ? cases.value.length : namedCases.value.length));
  const idleLabel = computed(() => main.value?.label ?? `Run ${count(testCount.value, 'test')} locally`);

  /** The face while a run of these tests goes on or just ended; null otherwise. */
  const statusFace = computed<ThisComputerFace | null>(() => {
    const run = contextRun.value;
    if (run && running.value) {
      return {
        label: localRunProgressLabel(run, runCount(run)),
        color: 'info',
        variant: 'subtle',
        icon: 'i-lucide-loader-circle',
        spinning: true,
        tooltip: 'A local run of these tests is going — view its output',
        status: true,
      };
    }
    const flashed = flashRun.value;
    if (!flashed) return null;
    const passed = flashed.status === 'passed';
    return {
      label: passed
        ? 'Passed'
        : flashed.exitCode != null && flashed.exitCode !== 1
          ? `Failed (exit ${flashed.exitCode})`
          : 'Failed',
      color: passed ? 'success' : 'error',
      variant: 'subtle',
      icon: passed ? 'i-lucide-check' : 'i-lucide-x',
      tooltip: 'View the run output',
      status: true,
    };
  });

  /** The face that runs the tests here: what it runs, the tests its plan leaves out, its options and environment. */
  function idleFace(primary: boolean): ThisComputerFace {
    const suffix = [
      leftOut.value > 0 && !noPlan.value ? `${leftOut.value} left out` : '',
      localRunOptionsSummary(options.value),
      runEnvironment.value?.name,
    ];
    const face: ThisComputerFace = {
      label: [idleLabel.value, ...suffix].filter(Boolean).join(' · '),
      color: primary ? 'primary' : 'neutral',
      variant: primary ? 'solid' : 'outline',
      icon: 'i-lucide-play',
      tooltip: '',
      status: false,
    };
    if (!linkLoaded.value) return { ...face, tooltip: 'Reading the linked folder…' };
    if (!linked.value) {
      return { ...face, tooltip: 'Link the folder that holds this project’s Playwright config to run tests here' };
    }
    if (noPlan.value) return { ...face, tooltip: noPlanHint.value };
    const command =
      plan.value.length === 1
        ? (plan.value[0]!.summary ?? plan.value[0]!.display)
        : `${plan.value.length} commands, one per project`;
    return { ...face, tooltip: `${command} · ${runModeLabel.value} · in ${link.value?.path}` };
  }

  /** The button waits for the link and the environments before a click runs anything. */
  const waiting = computed(() => busy.value || !linkLoaded.value || !environmentsReady.value);

  /** Run the button's tests, or one of the place's other sets, with the button's options and `patch` on top. */
  function runNow(patch?: LocalRunOptions, set?: LocalRunSet) {
    const runSet = set ?? main.value;
    if (projectId.value == null || !runSet || !environmentsReady.value) return;
    const started = store.startRun({
      projectId: projectId.value,
      projectLabel: projectLabel(),
      cases: runSet.cases,
      title: runSet.runTitle,
      sourceRunId: sourceRunId(),
      options: { ...runOptions(runSet, !set), ...patch },
      environment: runEnvironment.value,
    });
    if (started) input.onRun();
  }

  function openTray() {
    store.trayOpen.value = true;
  }

  // ── Copy as command, and the command the menu shows ───────────────────────
  /**
   * What the commands of a run from here start with: the project's run variables, or for an environment what the
   * shell reads for it (`readDesktopRunSettings`), its team project's for a team one.
   */
  const runVariables = useProjectRunVariables(projectId);
  const environmentSettings = ref<DesktopRunSettings | null>(null);
  watch(
    () => JSON.stringify(pickOf(runEnvironment.value)),
    async () => {
      const environment = runEnvironment.value;
      environmentSettings.value = null;
      if (!environment || projectId.value == null) return;
      try {
        const read = await readDesktopRunSettings(projectId.value, pickOf(environment));
        if (runEnvironment.value === environment) environmentSettings.value = read;
      } catch {
        // The commands start with the project's run variables; the shell says why when the run starts.
      }
    },
    { immediate: true },
  );
  const commandVariables = computed(() => environmentSettings.value?.runVariables ?? runVariables.variables.value);
  const commandEnvironment = computed(() => environmentSettings.value?.environment ?? null);

  /** What Copy as command copies: the shell form of the run, empty when no case has a filter a command can name. */
  const copyCommand = computed(() => {
    const command = buildRetryCommand(cases.value, {
      mode: options.value.mode,
      options: localRunCopyOptions(options.value),
    });
    return command
      ? commandWithEnvironment(command, commandVariables.value, commandEnvironment.value, runVariables.shell.value)
      : command;
  });
  /** The tests the run names that the copied command leaves out: a shell would misread their title or path. */
  const copyLeavesOut = computed(
    () => namedCases.value.filter((c) => !retryCommandNames(c, options.value.mode)).length,
  );
  const commandPreview = computed(() => {
    const shown = plan.value
      .slice(0, MAX_PREVIEW_STEPS)
      .map((step) =>
        commandWithEnvironment(step.summary ?? step.display, commandVariables.value, commandEnvironment.value, 'bash'),
      );
    const more = plan.value.length - shown.length;
    return more > 0 ? [...shown, `… and ${more} more`].join('\n') : shown.join('\n');
  });

  // ── The menu ──────────────────────────────────────────────────────────────
  /**
   * The button's menu: `elsewhere` (the one-click runs on CI) after the one-off runs here, and Run with options…
   * opening the dialog on This computer.
   */
  function menuGroups(elsewhere: DropdownMenuItem[], openDialog: () => void): DropdownMenuItem[][] {
    const groups: DropdownMenuItem[][] = [];

    if (!linked.value) {
      groups.push([
        { type: 'label', label: link.value ? 'The linked folder is missing' : 'No folder linked yet' },
        { label: 'Choose folder…', icon: 'i-lucide-folder-plus', onSelect: () => chooseFolder() },
      ]);
    } else if (wrongFolder.value) {
      groups.push([
        { type: 'label', label: 'Tests not found in the linked folder' },
        { label: 'Choose the right folder…', icon: 'i-lucide-folder-search', onSelect: () => chooseFolder() },
        { label: 'Run anyway', icon: 'i-lucide-play', disabled: noPlan.value, onSelect: () => runNow() },
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
        { label: 'Run anyway', icon: 'i-lucide-play', disabled: noPlan.value, onSelect: () => runNow() },
      ]);
    }

    if (linked.value) {
      groups.push([
        {
          type: 'label',
          label: noPlan.value
            ? 'Runs nothing'
            : plan.value.length === 1
              ? 'Runs this command'
              : 'Runs these commands, one by one',
        },
        {
          type: 'label',
          label: noPlan.value ? noPlanHint.value : commandPreview.value,
          class: 'font-mono text-[11px] font-normal',
          ui: { itemLabel: 'whitespace-pre-wrap! wrap-anywhere' },
        },
        ...(leftOut.value > 0 && !noPlan.value
          ? [
              {
                type: 'label' as const,
                label: `Leaves out ${leftOut.value} of the ${cases.value.length} tests: ${
                  options.value.mode === 'grep' ? 'they have no title' : 'Playwright cannot take their file paths'
                }`,
                class: 'font-normal text-muted',
              },
            ]
          : []),
      ]);

      groups.push([
        { type: 'label', label: 'Run once' },
        ...LOCAL_RUN_MODE_ITEMS.map((mode) => ({
          label: mode.label,
          icon: mode.icon,
          type: 'checkbox' as const,
          checked: options.value.runMode === mode.value,
          disabled: running.value || noPlan.value,
          onSelect: () => runNow({ runMode: mode.value }),
        })),
      ]);

      const sets = input.others().filter((set) => set.cases.length > 0);
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
    }

    if (elsewhere.length > 0) groups.push(elsewhere);

    if (linked.value) {
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
          label: 'Hold failures',
          icon: 'i-lucide-hand',
          type: 'checkbox',
          checked: localRunHoldsFailures(options.value),
          disabled: !!localRunHoldRefusal(options.value),
          description: localRunHoldRefusal(options.value) ?? undefined,
          onSelect: (e: Event) => {
            e.preventDefault();
            setOption({ holdFailures: !options.value.holdFailures });
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
        ...(options.value.repeatEach > 1
          ? [
              {
                label: 'Stop at the first failing repetition',
                icon: 'i-lucide-octagon-x',
                type: 'checkbox' as const,
                checked: options.value.stopAtFirstFailure,
                onSelect: (e: Event) => {
                  e.preventDefault();
                  setOption({ stopAtFirstFailure: !options.value.stopAtFirstFailure });
                },
              },
            ]
          : []),
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
        { label: 'Run with options…', icon: 'i-lucide-sliders-horizontal', onSelect: openDialog },
        {
          label: 'Copy as command',
          icon: 'i-lucide-clipboard',
          description:
            copyLeavesOut.value > 0
              ? `Names ${count(copyLeavesOut.value, 'test')} fewer than the run: a shell would misread ${copyLeavesOut.value === 1 ? 'its title or path' : 'their titles or paths'}`
              : undefined,
          disabled: !copyCommand.value,
          onSelect: () => void runVariables.ready().then(() => copy(copyCommand.value, { toast: 'Command copied' })),
        },
        {
          label: 'Project defaults…',
          icon: 'i-lucide-settings-2',
          to: `/projects/${input.projectId}?tab=settings&section=local-folder`,
        },
      ]);
    }

    groups.push([
      {
        label: store.activeCount.value > 0 ? `Local runs (${store.activeCount.value} active)` : 'Local runs',
        icon: 'i-lucide-terminal',
        onSelect: openTray,
      },
    ]);

    if (linked.value && !wrongFolder.value && missingSpecs.value.length > 0) {
      groups[groups.length - 1]!.unshift({
        type: 'label',
        label: `${count(missingSpecs.value.length, 'spec')} not in the linked folder`,
      });
    }

    if (linked.value) {
      groups.push([
        { type: 'label', label: link.value!.path, class: 'font-mono text-[11px] break-all font-normal' },
        { label: 'Change linked folder…', icon: 'i-lucide-folder-search', onSelect: () => chooseFolder() },
      ]);
    }

    return groups;
  }

  // ── The run dialog ────────────────────────────────────────────────────────
  /** The dialog's row of **This computer** for a What: the linked folder, or why it does not run the What. */
  function whereRow(local: ThisComputerWhat): RunWhereRow {
    const folder = !linkLoaded.value
      ? 'Reading the linked folder…'
      : linked.value
        ? `In ${link.value?.path}`
        : link.value
          ? 'The linked folder is missing'
          : 'No folder linked yet';
    const takes = localSetOf(local);
    return {
      value: 'local',
      label: DESKTOP_APP_NAME,
      description: takes ? folder : local && 'reason' in local ? local.reason : 'It does not run this.',
      disabled: !takes,
    };
  }

  /** The tests the dialog runs here, while it shows This computer; null otherwise. */
  const dialogSet = shallowRef<LocalRunSet | null>(null);
  const dialogCases = computed(() => dialogSet.value?.cases ?? []);
  const dialogSpecs = useDesktopSpecCheck(projectId, dialogCases);
  /** This run's options: the button's, each time the dialog shows This computer, then whatever the form changes. */
  const dialogOptions = ref<SavedLocalRunOptions>({ ...DEFAULT_LOCAL_RUN_OPTIONS });
  /** The environment this run is for, and whether its protection was confirmed for this run. */
  const dialogEnvironment = ref<DesktopEnvironmentChoice | null>(null);
  const dialogConfirmed = ref(false);
  /** What the shell sets for the environment picked, as it reads it; why it cannot, when it cannot. */
  const dialogSettings = ref<{ runVariables: RunVariable[]; environment: EnvironmentForRun | null }>({
    runVariables: [],
    environment: null,
  });
  const dialogSettingsProblem = ref<string | null>(null);
  let settingsAsked = 0;
  watch(
    [dialogSet, projectId, () => pickOf(dialogEnvironment.value)?.id, () => dialogEnvironment.value?.team],
    async () => {
      if (!dialogSet.value || projectId.value == null) return;
      const ask = ++settingsAsked;
      try {
        const answer = await readDesktopRunSettings(projectId.value, pickOf(dialogEnvironment.value));
        if (ask !== settingsAsked) return;
        dialogSettings.value = answer;
        dialogSettingsProblem.value = null;
      } catch (error) {
        if (ask !== settingsAsked) return;
        dialogSettings.value = { runVariables: [], environment: null };
        dialogSettingsProblem.value = errorMessage(error);
      }
    },
  );
  const dialogPlan = computed(() => buildLocalRunPlan(dialogCases.value, dialogOptions.value));
  const dialogPreview = computed(() =>
    dialogPlan.value
      .map((s) =>
        commandWithEnvironment(s.display, dialogSettings.value.runVariables, dialogSettings.value.environment, 'bash'),
      )
      .join('\n'),
  );
  const dialogCanRun = computed(
    () =>
      linked.value &&
      dialogPlan.value.length > 0 &&
      !busy.value &&
      environmentReady(dialogEnvironment.value, dialogConfirmed.value) &&
      !dialogSettingsProblem.value,
  );

  /** The What the dialog shows here, by its key: its options start again only when it changes. */
  let dialogKey: string | null = null;
  /**
   * Show `set`, the tests of the What `key` (the button's own when `main`), in the dialog's fields, with the button's
   * options; null when the dialog is closed or shows another Where. The same What again, as a run that goes on reports
   * more results, keeps what the form holds.
   */
  function showInDialog(set: LocalRunSet | null, key: string | null = null, main = false) {
    dialogSet.value = set;
    if (!set) {
      dialogKey = null;
      return;
    }
    if (key === dialogKey) return;
    dialogKey = key;
    dialogOptions.value = { ...store.getProjectOptions(input.projectId), ...runOptions(set, main) };
    void refresh();
    void dialogSpecs.checkSpecs(linked.value);
    void checkEnv();
  }
  watch([() => link.value?.path, linked, () => [...dialogSpecs.specFiles.value].sort().join('\n')], () => {
    if (dialogSet.value) void dialogSpecs.checkSpecs(linked.value);
  });

  /** Start the dialog's run, with its options and environment. */
  function runFromDialog(): boolean {
    const set = dialogSet.value;
    if (!set || projectId.value == null || !dialogCanRun.value) return false;
    const started = store.startRun({
      projectId: projectId.value,
      projectLabel: projectLabel(),
      cases: set.cases,
      title: set.runTitle,
      sourceRunId: sourceRunId(),
      options: dialogOptions.value,
      environment: dialogEnvironment.value,
      confirmed: dialogConfirmed.value,
    });
    dialogConfirmed.value = false;
    if (started) input.onRun();
    return !!started;
  }

  return reactive({
    available,
    takesMain,
    projectId: input.projectId,
    link,
    linked,
    linkLoaded,
    busy,
    attention,
    playwrightMissing,
    checkEnv,
    chooseFolder,
    statusFace,
    idleFace,
    noPlan,
    waiting,
    runNow,
    openTray,
    menuGroups,
    whereRow,
    dialog: reactive({
      set: dialogSet,
      options: dialogOptions,
      environment: dialogEnvironment,
      confirmed: dialogConfirmed,
      plan: dialogPlan,
      preview: dialogPreview,
      settingsProblem: dialogSettingsProblem,
      missingSpecs: dialogSpecs.missingSpecs,
      wrongFolder: dialogSpecs.wrongFolder,
      specFiles: dialogSpecs.specFiles,
      canRun: dialogCanRun,
    }),
    showInDialog,
    runFromDialog,
  });
}

/** A place's This computer, as `useThisComputer` answers it. */
export type ThisComputer = ReturnType<typeof useThisComputer>;
