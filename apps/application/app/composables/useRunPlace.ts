import type { RunRequestOptions } from '@piwitests/core/run-request';
import type { CiActionKind } from '#shared/ci-actions';
import {
  ciRefProblem,
  type CiDispatchSourceInput,
  type CiOffered,
  type CiOfferedAction,
} from '#shared/ci-dispatch-request';
import type { CiDispatchView } from '#shared/ci-dispatches';
import type { ShownEnvironment } from '~/composables/useCommandEnvironment';
import type { RunOnMyMachine, RunRequestSourceChoice } from '~/composables/useRunOnMyMachine';
import { localSetOf, type ThisComputerPlace, type ThisComputerWhat } from '~/composables/useThisComputer';
import { keepRunWhere, keptRunWhere } from '~/utils/run-where';

/** One thing a place can run, as the run dialog lists it under **What**. */
export interface RunWhat {
  key: string;
  label: string;
  /** How many tests it names, as the page counts them, when it knows. */
  count?: number;
  /** It is the project's whole suite. */
  wholeSuite?: boolean;
  /** The titles of its tests, shown under **What** and not editable. */
  tests?: readonly string[];
  /** What a run request to one of the person's apps sends; a reason when the apps cannot take it; null when not offered. */
  app: { source: RunRequestSourceChoice; projects?: readonly string[] } | { reason: string } | null;
  /** What a CI dispatch sends, with a line said under **What** when CI is picked; null when CI does not run it. */
  ci: { source: CiDispatchSourceInput; note?: string } | null;
  /** What a run on this computer runs, in the desktop window; a reason when it cannot; absent when not offered. */
  local?: ThisComputerWhat;
}

/** How the run dialog opens: on a What (the place's first by default), on CI, or on Whats of its own (a Next action). */
export interface RunDialogOpening {
  whats?: RunWhat[];
  what?: string;
  where?: 'ci' | 'local';
}

/** A one-click run of the button's menu: the place's first What, to one CI action or one online app. */
export interface RunShortcut {
  label: string;
  where: string;
}

/** A row of **Where**. */
export interface RunWhereRow {
  value: string;
  label: string;
  description: string;
  disabled: boolean;
}

/** What a dispatch of each kind is, in "Does not take …". */
const KIND_NOUNS: Record<CiActionKind, string> = { tests: 're-runs', suite: 'a whole suite', flakeLab: 'Flake Lab' };

/** What a shortcut of each kind starts, in its menu row. */
const KIND_SHORTCUTS: Record<CiActionKind, string> = {
  tests: 'Re-run on CI',
  suite: 'Run on CI',
  flakeLab: 'Flake Lab on CI',
};

/** The CI a target is on, as a shortcut names it: `GitHub`, `Jenkins`. */
function providerOf(action: CiOfferedAction): string {
  switch (action.target.type) {
    case 'github':
      return 'GitHub';
    case 'gitlab':
      return 'GitLab';
    case 'bitbucket':
      return 'Bitbucket';
    case 'ci-server': {
      const name = action.target.label.split(' · ')[0]!;
      return name === 'Custom request' ? 'CI server' : name;
    }
  }
}

/** What a sent run was, so **Run again** sends it the same way. */
type SentRun =
  | {
      kind: 'app';
      source: RunRequestSourceChoice;
      options: RunRequestOptions;
      targetId: number;
      environmentId: number | null;
    }
  | {
      kind: 'ci';
      body: { source: CiDispatchSourceInput; action: string; ref?: string; inputs?: Record<string, string> };
    };

export interface RunPlaceOptions {
  projectId: number;
  /** What the place runs, the first one picked when the dialog opens. */
  whats: () => RunWhat[];
  /** A re-run place or a whole suite: the dialog picks the default CI action before an app. */
  prefersCi: () => boolean;
  /** The person's apps on the project's pages: `await useRunOnMyMachine(projectId)` in the page's own setup. */
  machine: RunOnMyMachine;
  /** The environment of the run the page shows, which a request starts on (`useCommandEnvironment`). */
  shownEnvironment?: () => number | ShownEnvironment | null | undefined;
  /** Hears each CI dispatch sent from here, so the page reads its last re-run again. */
  onDispatched?: (dispatch: CiDispatchView) => void;
  /** What the runs on this computer share, in the desktop window (`useThisComputer`). */
  thisComputer?: ThisComputerPlace;
}

/**
 * One place's run: the split button's face and shortcuts, and the run dialog's What, Where, fields, Send and
 * follow-up, which `RunButton` and `RunDialog` render. The person's apps come from `useRunOnMyMachine`, which the page
 * awaits in its own setup and hands in, and the CI actions each What is offered from
 * `GET /api/projects/:id/ci-actions/offered`, read for a person who holds `run:control`: the place's first What with
 * the page, so the button renders on the server as it stays, and the others in the browser. Awaited in the page's
 * setup, and returned reactive, so a component reads its fields as values.
 */
export async function useRunPlace(options: RunPlaceOptions) {
  const { projectId, machine } = options;
  const toast = useToast();
  const { can } = useAuth();
  const { prefs, project } = useRetryOptions();
  const followUp = useRunFollowUp({
    onRun: (runId) => {
      if (open.value) return;
      toast.add({
        title: `Run #${runId} reported`,
        description: 'The run you started from this page is reporting.',
        color: 'neutral',
        actions: [{ label: `Open run #${runId}`, to: `/test-runs/${runId}`, color: 'neutral', variant: 'outline' }],
      });
    },
  });
  const shown = () => options.shownEnvironment?.();
  const { environmentId, offered: environmentOffered } = useCommandEnvironment(projectId, shown, {
    listOnMount: false,
  });
  const {
    byId: environmentById,
    loaded: environmentsLoaded,
    refresh: readEnvironments,
  } = useProjectEnvironments(projectId, { onMount: false });

  const mayDispatch = computed(() => can('run:control', projectId));
  const open = ref(false);
  const override = shallowRef<RunWhat[] | null>(null);
  const whats = computed(() => override.value ?? options.whats());
  const whatKey = ref<string | undefined>(undefined);
  const what = computed(() => whats.value.find((w) => w.key === whatKey.value) ?? whats.value[0] ?? null);
  const where = ref<string | undefined>(undefined);
  /** Each What's CI offer by its key: undefined until read, null when it cannot be read. */
  const offered = reactive<Record<string, CiOffered | null | undefined>>({});
  /** The source each offer was read for, so a What whose source changes is read again. */
  const offeredFor: Record<string, string> = {};
  const ready = ref(false);
  const branch = ref('');
  const inputs = reactive<Record<string, string>>({});
  const branches = ref<string[]>([]);
  const sending = ref(false);
  const stopping = ref(false);
  const sendError = ref<string | null>(null);
  const skipped = ref(0);
  let lastSent: SentRun | null = null;

  // ── What each destination offers ──────────────────────────────────────────
  const requestFetch = useRequestFetch();
  /** The offer of the What the page opens with, read with the page: one read, for what the button says. */
  const openingWhat = options.whats()[0];
  const firstOffer = useAsyncData(
    `run-place-offered-${projectId}-${openingWhat?.key}-${JSON.stringify(openingWhat?.ci?.source ?? null)}`,
    async () => {
      if (!mayDispatch.value || !openingWhat?.ci) return null;
      const source = openingWhat.ci.source;
      const offer = await requestFetch<CiOffered>(`/api/projects/${projectId}/ci-actions/offered`, {
        query: source,
      }).catch(() => null);
      return { key: openingWhat.key, source: JSON.stringify(source), offer };
    },
    { default: () => null },
  );
  watch(
    firstOffer.data,
    (read) => {
      if (!read || offered[read.key] !== undefined) return;
      offeredFor[read.key] = read.source;
      offered[read.key] = read.offer;
    },
    { immediate: true },
  );

  async function readOffered(list: RunWhat[]) {
    if (!mayDispatch.value) return;
    await Promise.all(
      list.map(async (w) => {
        if (!w.ci) return;
        const source = JSON.stringify(w.ci.source);
        if (offeredFor[w.key] === source && offered[w.key] !== undefined) return;
        offeredFor[w.key] = source;
        try {
          const read = await $fetch<CiOffered>(`/api/projects/${projectId}/ci-actions/offered`, {
            query: w.ci.source,
          });
          if (offeredFor[w.key] === source) offered[w.key] = read;
        } catch {
          if (offeredFor[w.key] === source) offered[w.key] = null;
        }
      }),
    );
  }

  /** Whether a What's CI has an action that can be sent. */
  const ciTakes = (w: RunWhat) => {
    const offer = offered[w.key];
    return Boolean(w.ci && offer?.enabled && offer.actions.some((a) => a.available));
  };

  // The first What says what the button shows; with CI actions on, the others are read when it cannot go to CI, else
  // when the dialog opens.
  onMounted(() => {
    watch(
      () => JSON.stringify(options.whats().map((w) => [w.key, w.ci?.source ?? null])),
      async () => {
        const [first, ...others] = options.whats();
        if (!first) return;
        await readOffered([first]);
        if (offered[first.key]?.enabled && !ciTakes(first)) await readOffered(others);
      },
      { immediate: true },
    );
  });
  const appsAvailable = computed(
    () => machine.shown.value && options.whats().some((w) => w.app != null && 'source' in w.app),
  );
  const ciAvailable = computed(() => mayDispatch.value && options.whats().some(ciTakes));
  // ── This computer, in the desktop window ─────────────────────────────────
  /** The Where last sent to here, which the button's face follows. */
  const keptWhere = ref<string | null>(null);
  onMounted(() => (keptWhere.value = keptRunWhere(projectId)));
  function keep(sentTo: string) {
    keepRunWhere(projectId, sentTo);
    keptWhere.value = sentTo;
  }
  const here = useThisComputer({
    projectId,
    place: options.thisComputer,
    main: () => localSetOf(options.whats()[0]?.local),
    others: () =>
      options
        .whats()
        .slice(1)
        .flatMap((w) => localSetOf(w.local) ?? []),
    onRun: () => keep('local'),
  });
  const hereTakes = (list: RunWhat[]) => here.available && list.some((w) => localSetOf(w.local));
  /** The button runs its first What here at once, unless the last Where is a CI action that takes it. */
  const mainHere = computed(() => {
    const first = options.whats()[0];
    if (!here.takesMain) return false;
    const kept = keptWhere.value;
    const offer = first ? offered[first.key] : undefined;
    return !(
      kept?.startsWith('ci:') &&
      mayDispatch.value &&
      offer?.enabled &&
      offer.actions.some((a) => `ci:${a.id}` === kept && a.available)
    );
  });

  const visible = computed(() => appsAvailable.value || ciAvailable.value || hereTakes(options.whats()));
  /** The destinations a list of Whats can go to, as the button and the dialog name them. */
  function runLabel(list: RunWhat[]): string {
    const apps = machine.shown.value && list.some((w) => w.app != null && 'source' in w.app);
    const ci = mayDispatch.value && list.some(ciTakes);
    const mine = apps ? 'my machine' : hereTakes(list) ? 'this computer' : null;
    if (mine && ci) return `Run on ${mine} or CI`;
    return ci ? 'Run on CI' : `Run on ${mine ?? 'my machine'}`;
  }
  const label = computed(() => runLabel(options.whats()));

  // ── Where ─────────────────────────────────────────────────────────────────
  const appsShown = computed(() => machine.shown.value && whats.value.some((w) => w.app != null));
  const appRows = computed<RunWhereRow[]>(() => {
    if (!appsShown.value) return [];
    const app = what.value?.app;
    return machine.apps.value.map((a) => {
      const facts = [
        a.target.online ? 'Online' : 'Offline',
        a.target.projectIds.includes(projectId)
          ? 'has a folder for this project'
          : 'asks for the folder of this project',
      ].join(' · ');
      const takes = app != null && 'source' in app;
      return {
        value: `app:${a.target.id}`,
        label: a.name,
        description: takes ? facts : app && 'reason' in app ? app.reason : 'Your apps do not run this.',
        disabled: !takes,
      };
    });
  });

  /** The dialog's title: where its Whats, a Next action's included, can go. */
  const dialogTitle = computed(() => runLabel(whats.value));

  /** Every CI action any What of the dialog is offered, each once, in the order of the Whats and of each offer. */
  const ciActions = computed(() => {
    const seen = new Map<string, CiOfferedAction>();
    for (const w of whats.value) {
      for (const action of offered[w.key]?.actions ?? []) if (!seen.has(action.id)) seen.set(action.id, action);
    }
    return [...seen.values()];
  });
  const ciShown = computed(
    () => mayDispatch.value && whats.value.some((w) => offered[w.key]?.enabled) && ciActions.value.length > 0,
  );
  const ciOffer = computed(() => (what.value ? offered[what.value.key] : undefined));
  const ciRows = computed<RunWhereRow[]>(() => {
    if (!ciShown.value) return [];
    const w = what.value;
    return ciActions.value.map((action) => {
      const facts = [action.target.label, action.environment].filter(Boolean).join(' · ');
      const here = ciOffer.value?.actions.find((a) => a.id === action.id);
      let reason: string | null = null;
      if (!w?.ci) reason = 'CI does not run this.';
      else if (ciOffer.value === undefined) reason = 'Reading what it takes…';
      else if (ciOffer.value === null) reason = 'CI cannot run this from here.';
      else if (!ciOffer.value.enabled) reason = 'CI actions are off for this project.';
      else if (!here) reason = `Does not take ${KIND_NOUNS[ciOffer.value.kind]}.`;
      else if (!here.available) reason = here.reason ?? 'It cannot be sent from here.';
      return {
        value: `ci:${action.id}`,
        label: action.name,
        description: reason ? `${facts} · ${reason}` : facts,
        disabled: reason != null,
      };
    });
  });

  const localShown = computed(() => here.available && whats.value.some((w) => w.local != null));
  const localRows = computed<RunWhereRow[]>(() => (localShown.value ? [here.whereRow(what.value?.local)] : []));
  const row = (key: string | null | undefined) =>
    [...appRows.value, ...localRows.value, ...ciRows.value].find((r) => r.value === key && !r.disabled);
  /** The tests the dialog runs on this computer, when it is picked. */
  const localPick = computed(() => (where.value === 'local' && row('local') ? localSetOf(what.value?.local) : null));
  /** The CI action picked, as the picked What is offered it. */
  const ciPick = computed(() => {
    const key = where.value;
    if (!key?.startsWith('ci:') || !row(key)) return null;
    return ciOffer.value?.actions.find((a) => `ci:${a.id}` === key) ?? null;
  });
  const appPick = computed(() => {
    const key = where.value;
    if (!key?.startsWith('app:') || !row(key)) return null;
    return machine.apps.value.find((a) => `app:${a.target.id}` === key) ?? null;
  });

  /**
   * The CI action a What starts on by default: the place's default (the action that started its run, else its
   * environment's, else the kind's), else the first that can be sent.
   */
  function ciDefault(w: RunWhat): string | null {
    const id = offered[w.key]?.defaultActionId;
    if (id && row(`ci:${id}`)) return `ci:${id}`;
    return ciRows.value.find((r) => !r.disabled)?.value ?? null;
  }

  /** The Where a What opens on: the one last sent to here, else the place's default destination. */
  function defaultWhere(w: RunWhat, useKept: boolean): string | null {
    const kept = useKept ? keptRunWhere(projectId) : null;
    if (kept && row(kept)) return kept;
    if (row('local')) return 'local';
    const ci = ciDefault(w);
    const apps = appRows.value.filter((r) => !r.disabled);
    const online = apps.find((r) =>
      machine.apps.value.some((a) => `app:${a.target.id}` === r.value && a.target.online),
    );
    if (options.prefersCi()) return ci ?? online?.value ?? apps[0]?.value ?? null;
    return online?.value ?? ci ?? apps[0]?.value ?? null;
  }

  // A What the picked Where cannot take moves the pick to the What's default.
  watch(whatKey, () => {
    if (!ready.value || !what.value || row(where.value)) return;
    where.value = defaultWhere(what.value, false) ?? undefined;
  });

  // ── The fields of a CI pick ───────────────────────────────────────────────
  let branchTimer: ReturnType<typeof setTimeout> | null = null;
  async function readBranches(action: CiOfferedAction, q: string) {
    try {
      const { items } = await $fetch<{ items: { name: string }[] }>(
        `/api/projects/${projectId}/ci-actions/${encodeURIComponent(action.id)}/branches`,
        { query: q ? { q } : {} },
      );
      if (ciPick.value?.id === action.id) branches.value = items.map((b) => b.name);
    } catch {
      branches.value = [];
    }
  }
  function resetCiFields(action: CiOfferedAction | null) {
    branches.value = [];
    branch.value = action?.branch.default ?? '';
    for (const key of Object.keys(inputs)) delete inputs[key];
    for (const input of action?.inputs ?? []) if (input.kind === 'choice') inputs[input.name] = input.default;
    if (action && action.branch.mode !== 'fixed') void readBranches(action, '');
  }
  watch(
    () => (ciPick.value ? `${what.value?.key}|${ciPick.value.id}` : null),
    () => resetCiFields(ciPick.value),
  );
  /** Read the branches holding what is typed, a moment after the typing stops. */
  function searchBranches(q: string) {
    const action = ciPick.value;
    if (!action || action.branch.mode === 'fixed') return;
    if (branchTimer) clearTimeout(branchTimer);
    branchTimer = setTimeout(() => void readBranches(action, q.trim()), 300);
  }
  onScopeDispose(() => {
    if (branchTimer) clearTimeout(branchTimer);
  });
  const refProblem = computed(() => {
    const value = branch.value.trim();
    return ciPick.value && ciPick.value.branch.mode !== 'fixed' && value ? ciRefProblem(value) : null;
  });

  // ── The fields of an app pick ─────────────────────────────────────────────
  /** The protected environment picked, whose run keeps to the tests carrying its required tags; null for another pick. */
  const protectedPick = computed(() => {
    const picked = environmentById(environmentId.value);
    return picked?.protected ? picked : null;
  });
  const whatProjects = computed(() => {
    const app = what.value?.app;
    return app && 'source' in app ? (app.projects ?? []) : [];
  });
  /** The run options of Copy retry command, as a request takes them. */
  function requestOptions(): RunRequestOptions {
    const p = prefs.value;
    const result: RunRequestOptions = { headed: p.headed };
    if (p.trace) result.trace = p.trace;
    if (p.repeatEach > 1) result.repeatEach = p.repeatEach;
    if (p.workers) result.workers = p.workers;
    const projects = whatProjects.value;
    if (project.value && projects.length > 1 && projects.includes(project.value)) result.project = project.value;
    return result;
  }

  // ── Opening, sending, following ───────────────────────────────────────────
  /** Read what the dialog offers: the person's apps and the project's environments for them, and each What's CI. */
  async function prepare() {
    ready.value = false;
    if (appsShown.value && !environmentsLoaded.value) void readEnvironments();
    await Promise.all([appsShown.value ? machine.loadApps() : null, readOffered(whats.value)]);
    ready.value = true;
  }

  /** Open the dialog: the last run sent from here while it is shown, else the form on the place's first What. */
  async function openDialog(opening: RunDialogOpening = {}) {
    const fresh = opening.whats != null || opening.what != null || opening.where != null;
    open.value = true;
    // The run shown keeps the Whats it was sent from.
    if (followUp.view.value && !fresh) return;
    override.value = opening.whats ?? null;
    followUp.reset();
    sendError.value = null;
    whatKey.value = opening.what ?? whats.value[0]?.key;
    where.value = undefined;
    await prepare();
    const w = what.value;
    if (!w) return;
    where.value =
      (opening.where === 'ci'
        ? (ciDefault(w) ?? defaultWhere(w, false))
        : opening.where === 'local' && row('local')
          ? 'local'
          : defaultWhere(w, true)) ?? undefined;
  }
  // The dialog's fields of This computer follow the What it runs here.
  watch([open, localPick], () => here.showInDialog(open.value ? localPick.value : null));

  /** Back to the form, on the What and Where of the last run while the dialog still offers them. */
  async function newRun() {
    followUp.reset();
    sendError.value = null;
    await prepare();
    if (!whats.value.some((w) => w.key === whatKey.value)) whatKey.value = whats.value[0]?.key;
    if (what.value && !row(where.value)) where.value = defaultWhere(what.value, false) ?? undefined;
  }

  async function sendRun(sent: SentRun) {
    sending.value = true;
    sendError.value = null;
    try {
      if (sent.kind === 'app') {
        const made = await machine.send(sent.source, sent.options, sent.targetId, sent.environmentId);
        skipped.value = made.skipped;
        followUp.follow({ kind: 'request', view: made });
      } else {
        const dispatch = await $fetch<CiDispatchView>(`/api/projects/${projectId}/ci-dispatches`, {
          method: 'POST',
          body: sent.body,
        });
        followUp.follow({ kind: 'dispatch', view: dispatch });
        options.onDispatched?.(dispatch);
      }
      lastSent = sent;
    } catch (error) {
      // The same dispatch went out a moment ago: follow that one.
      const earlier = (error as { statusCode?: number; data?: { data?: { dispatch?: CiDispatchView } } } | null)?.data
        ?.data?.dispatch;
      if (earlier) {
        followUp.follow({ kind: 'dispatch', view: earlier });
        lastSent = sent;
      } else sendError.value = errorMessage(error);
    } finally {
      sending.value = false;
    }
  }

  /** What the form sends to the picked Where, or null when it cannot be sent. */
  function formRun(withFields: boolean): SentRun | null {
    const w = what.value;
    const key = where.value;
    if (!w || !key || !row(key)) return null;
    if (key.startsWith('app:')) {
      if (!w.app || !('source' in w.app)) return null;
      return {
        kind: 'app',
        source: w.app.source,
        options: requestOptions(),
        targetId: Number(key.slice('app:'.length)),
        environmentId: environmentId.value,
      };
    }
    const action = ciOffer.value?.actions.find((a) => `ci:${a.id}` === key);
    if (!action || !w.ci) return null;
    const body: Extract<SentRun, { kind: 'ci' }>['body'] = { source: w.ci.source, action: action.id };
    if (withFields) {
      const ref = branch.value.trim();
      if (action.branch.mode !== 'fixed' && ref) body.ref = ref;
      if (Object.keys(inputs).length) body.inputs = { ...inputs };
    }
    return { kind: 'ci', body };
  }

  const canSend = computed(() =>
    localPick.value ? ready.value && here.dialog.canRun : ready.value && Boolean(formRun(true)) && !refProblem.value,
  );

  async function send() {
    if (localPick.value) {
      if (here.runFromDialog()) open.value = false;
      return;
    }
    const sent = formRun(true);
    if (!sent || sending.value || refProblem.value) return;
    await sendRun(sent);
    if (where.value && followUp.view.value) keep(where.value);
  }

  async function runAgain() {
    if (lastSent && !sending.value) await sendRun(lastSent);
  }

  async function stopRun() {
    stopping.value = true;
    try {
      await followUp.stop();
    } finally {
      stopping.value = false;
    }
  }

  // ── The button's one-click runs ───────────────────────────────────────────
  const firstWhat = computed(() => options.whats()[0] ?? null);
  const shortcuts = computed<RunShortcut[]>(() => {
    const w = firstWhat.value;
    if (!w) return [];
    const list: RunShortcut[] = [];
    const offer = offered[w.key];
    if (mayDispatch.value && w.ci && offer?.enabled) {
      const available = offer.actions.filter((a) => a.available);
      available.sort((a, b) => Number(b.id === offer.defaultActionId) - Number(a.id === offer.defaultActionId));
      for (const action of available) {
        list.push({
          label: `${KIND_SHORTCUTS[offer.kind]} · ${action.name} (${providerOf(action)})`,
          where: `ci:${action.id}`,
        });
      }
    }
    if (machine.shown.value && w.app && 'source' in w.app) {
      for (const app of machine.apps.value.filter((a) => a.target.online)) {
        list.push({ label: `Send to ${app.name}`, where: `app:${app.target.id}` });
      }
    }
    return list;
  });
  /** The menu waits for the person's apps, which it lists once read. */
  const shortcutsLoading = computed(() => {
    const app = firstWhat.value?.app;
    return machine.shown.value && app != null && 'source' in app && !machine.appsLoaded.value;
  });
  /** Read the person's apps for the menu, when it opens. */
  function loadShortcuts() {
    if (machine.shown.value && !machine.appsLoaded.value) void machine.loadApps();
  }

  /** Send the place's first What to one Where with its defaults, then show it in the dialog. */
  async function sendShortcut(shortcut: RunShortcut) {
    override.value = null;
    followUp.reset();
    whatKey.value = firstWhat.value?.key;
    where.value = shortcut.where;
    ready.value = true;
    open.value = true;
    const sent = formRun(false);
    if (!sent) return;
    await sendRun(sent);
    if (followUp.view.value) keep(shortcut.where);
  }

  await firstOffer;
  return reactive({
    projectId,
    visible,
    label,
    dialogTitle,
    open,
    ready,
    whats,
    whatKey,
    what,
    where,
    ciOffer,
    appsShown,
    appRows,
    localShown,
    localRows,
    localPick,
    here,
    mainHere,
    ciShown,
    ciRows,
    ciPick,
    appPick,
    branch,
    branches,
    inputs,
    refProblem,
    environmentId,
    environmentOffered,
    protectedPick,
    whatProjects,
    canSend,
    sending,
    stopping,
    sendError,
    skipped,
    followUp: followUp.view,
    followUpError: followUp.error,
    shortcuts,
    shortcutsLoading,
    openDialog,
    newRun,
    send,
    runAgain,
    stopRun,
    searchBranches,
    loadShortcuts,
    sendShortcut,
  });
}

/** One place's run, as `RunButton` and `RunDialog` take it. */
export type RunPlace = Awaited<ReturnType<typeof useRunPlace>>;
