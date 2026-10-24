<script setup lang="ts">
/**
 * One dashboard on screen: its header (the switcher and the dashboard
 * actions), its meta line, the Filters block, and its bands of widgets. In
 * edit mode the same page edits the definition: bands and widgets are moved
 * with buttons, every widget previews from the unsaved definition, and the
 * block, titled Default filters, sets the dashboard's default scope. In TV mode (`?tv=1`) the page drops the
 * navigation, refreshes itself and can rotate through several dashboards.
 */
import { getAnalyticsWidget, type AnalyticsWidgetId } from '#shared/analytics/registry';
import { hasTestFilter, type AnalyticsScope } from '#shared/analytics/scope';
import { scopeFromState, stateFromScope } from '#shared/analytics/scope-state';
import {
  applyWidgetScope,
  dashboardScope,
  nextWidgetKey,
  resolveDashboard,
  type DashboardDefinition,
  type DashboardWidget,
} from '#shared/analytics/dashboards';
import type { DashboardList, DashboardView } from '#shared/handlers/dashboards';
import type { ProjectMenuItem, TestRunForChart } from '~~/types/api';

const props = defineProps<{ view: DashboardView; list: DashboardList | null; tv: boolean }>();
const emit = defineEmits<{ saved: [view: DashboardView] }>();

const route = useRoute();
const toast = useToast();
const isOverview = props.view.id === 'overview';
const isSaved = props.view.kind === 'saved';

const { state, scope, scopeQuery, reset } = useAnalyticsScope(
  isOverview ? {} : { defaultState: stateFromScope(dashboardScope(props.view.definition)) },
);
const { isHidden } = await useInstanceCapabilities();
// A dashboard spans projects: scheduling its report and its live links show to
// the holders of `report:write` and `share:create` on at least one project.
const { canAnywhere } = useAuth();
const canScheduleReports = computed(() => canAnywhere('report:write'));
const canShareLinks = computed(() => canAnywhere('share:create'));
const reportOpen = ref(false);
const liveLinksOpen = ref(false);
// Share links need the server; the public demo has no share-link routes.
const isDemoMode = Boolean(useRuntimeConfig().public.demoMode);
const scheduleOpen = ref(false);
const testFilterActive = computed(() => hasTestFilter(scope.value));

// How the scope resolves: period dates, notes, markers for the trends, and the
// options of the Tests filter. The trend charts read it through inject.
const { data: scopeSummary } = await useAnalyticsScopeSummary(() => scopeQuery.value);
provide(ANALYTICS_SCOPE_SUMMARY, scopeSummary);

// The projects of the scope the viewer cannot open: a dashboard grants no access.
const { data: accessView } = useFetch<Pick<DashboardView, 'hiddenProjects'>>(`/api/dashboards/${props.view.id}`, {
  query: scopeQuery,
  lazy: true,
  server: false,
  pick: ['hiddenProjects'],
});
const hiddenProjects = computed(() => accessView.value?.hiddenProjects ?? props.view.hiddenProjects);

// Project options for the Filters block (slim list, same source as the sidebar menu).
const { data: availableProjects } = await useFetch('/api/projects/menu', {
  lazy: true,
  server: false,
  default: () => [] as ProjectMenuItem[],
  transform: (r: { items: ProjectMenuItem[] }) => r.items,
});

// Environment options for the Filters block (same source as the home filters).
const { data: recentTestRuns } = await useFetch('/api/test-runs/recent', {
  lazy: true,
  server: false,
  default: () => [] as TestRunForChart[],
  transform: (r: { items: TestRunForChart[] }) => r.items,
});

const availableEnvironments = computed(() => {
  const envSet = new Set<string>();
  for (const run of recentTestRuns.value ?? []) {
    if (run.environment) envSet.add(run.environment);
  }
  return [...envSet].sort();
});

const availableBranches = computed(() => {
  const branchSet = new Set<string>();
  for (const run of recentTestRuns.value ?? []) {
    if (run.branch) branchSet.add(run.branch);
  }
  return [...branchSet].sort();
});

// "Looks empty when it isn't": if the newest run predates the selected window,
// every widget shows zeroes even though there IS history. Detect it and offer to
// widen, rather than leaving the user staring at an empty scorecard.
const newestRunTime = computed(() => {
  const runs = recentTestRuns.value ?? [];
  if (runs.length === 0) return null;
  return Math.max(...runs.map((r) => new Date(r.startTime).getTime()));
});

const windowHidesData = computed(() => {
  if (newestRunTime.value === null) return false; // no runs at all — a genuine empty state
  if (state.value.period === 'all') return false; // already showing everything
  const period = scopeSummary.value?.period;
  if (!period) return false;
  return newestRunTime.value < new Date(period.from).getTime();
});

function widenToAllTime() {
  state.value = { ...state.value, period: 'all' };
}

// ── Editing ──────────────────────────────────────────────────────────────────

const editing = ref(false);
const draft = ref<DashboardDefinition | null>(null);
const saving = ref(false);
const conflictOpen = ref(false);
const saveAsOpen = ref(false);
const saveAsName = ref('');

const definition = computed(() => (editing.value && draft.value ? draft.value : props.view.definition));
const bands = computed(() => resolveDashboard(definition.value));
const mode = computed(() => (editing.value ? 'preview' : isSaved ? 'dashboard' : 'type'));

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function startEditing() {
  draft.value = clone(props.view.definition);
  editing.value = true;
}

function cancelEditing() {
  editing.value = false;
  draft.value = null;
  reset();
}

/** The definition a save writes: the draft, with the Default filters as its default scope. */
function definitionToSave(): DashboardDefinition {
  return { ...clone(draft.value ?? props.view.definition), scope: scopeFromState(state.value) };
}

async function save() {
  saving.value = true;
  try {
    const saved = await $fetch<DashboardView>(`/api/dashboards/${props.view.id}`, {
      method: 'PATCH',
      body: { definition: definitionToSave(), updatedAt: props.view.updatedAt },
    });
    editing.value = false;
    draft.value = null;
    emit('saved', saved);
    toast.add({ title: 'Dashboard saved', color: 'success' });
  } catch (error: any) {
    if (error?.statusCode === 409 || error?.response?.status === 409) conflictOpen.value = true;
    else toast.add({ title: "Couldn't save the dashboard", description: errorMessage(error), color: 'error' });
  } finally {
    saving.value = false;
  }
}

function openSaveAs() {
  saveAsName.value = `Copy of ${props.view.name}`;
  conflictOpen.value = false;
  saveAsOpen.value = true;
}

async function saveAs() {
  if (!saveAsName.value.trim()) return;
  saving.value = true;
  try {
    const created = await $fetch<DashboardView>('/api/dashboards', {
      method: 'POST',
      body: { name: saveAsName.value.trim(), visibility: 'private', definition: definitionToSave() },
    });
    saveAsOpen.value = false;
    editing.value = false;
    await navigateTo(`/analytics/d/${created.id}`);
  } catch (error) {
    toast.add({ title: "Couldn't save the copy", description: errorMessage(error), color: 'error' });
  } finally {
    saving.value = false;
  }
}

function reloadAfterConflict() {
  conflictOpen.value = false;
  editing.value = false;
  draft.value = null;
  reloadNuxtApp({ path: route.fullPath });
}

async function duplicate() {
  try {
    const copy = await $fetch<DashboardView>(`/api/dashboards/${props.view.id}/duplicate`, {
      method: 'POST',
      body: {},
    });
    await navigateTo(`/analytics/d/${copy.id}?edit=1`);
  } catch (error) {
    toast.add({ title: "Couldn't duplicate the dashboard", description: errorMessage(error), color: 'error' });
  }
}

// Arriving from *Duplicate* opens the copy in edit mode.
onMounted(() => {
  if (route.query.edit === '1' && props.view.canEdit) {
    startEditing();
    const { edit: _edit, ...rest } = route.query;
    void navigateTo({ query: rest }, { replace: true });
  }
});

onBeforeRouteLeave(() => {
  if (editing.value && !window.confirm('Leave without saving this dashboard?')) return false;
});

// Band and widget operations on the draft.
function bandOf(b: number) {
  return draft.value!.bands[b]!;
}

function moveBand(b: number, delta: number) {
  const list = draft.value!.bands;
  const [band] = list.splice(b, 1);
  list.splice(b + delta, 0, band!);
}

function removeBand(b: number) {
  const band = bandOf(b);
  if (band.widgets.length > 0 && !window.confirm(`Remove the band “${band.title}” and its widgets?`)) return;
  draft.value!.bands.splice(b, 1);
}

function addBand() {
  draft.value!.bands.push({ title: 'New band', widgets: [] });
}

function moveWidget(b: number, w: number, delta: number) {
  const widgets = bandOf(b).widgets;
  const [widget] = widgets.splice(w, 1);
  widgets.splice(w + delta, 0, widget!);
}

function moveWidgetToBand(b: number, w: number, target: number) {
  const [widget] = bandOf(b).widgets.splice(w, 1);
  bandOf(target).widgets.push(widget!);
}

function toggleWidth(b: number, w: number) {
  const widget = bandOf(b).widgets[w]!;
  widget.size = widget.size === 'full' ? 'half' : 'full';
}

function duplicateWidget(b: number, w: number) {
  const widget = clone(bandOf(b).widgets[w]!);
  widget.key = nextWidgetKey(draft.value!, widget.type);
  bandOf(b).widgets.splice(w + 1, 0, widget);
}

function removeWidget(b: number, w: number) {
  bandOf(b).widgets.splice(w, 1);
}

const addTarget = ref<number | null>(null);
const addOpen = ref(false);
const configTarget = ref<{ b: number; w: number } | null>(null);
const configOpen = ref(false);
const configWidget = computed<DashboardWidget | null>(() =>
  configTarget.value && draft.value
    ? (draft.value.bands[configTarget.value.b]?.widgets[configTarget.value.w] ?? null)
    : null,
);

function openAdd(b: number) {
  addTarget.value = b;
  addOpen.value = true;
}

function addWidget(type: AnalyticsWidgetId) {
  const b = addTarget.value;
  if (b === null || !draft.value) return;
  const widgets = bandOf(b).widgets;
  widgets.push({ key: nextWidgetKey(draft.value, type), type, size: getAnalyticsWidget(type).size });
  // A widget with options is configured next, once the picker has closed.
  pendingConfig.value = getAnalyticsWidget(type).options ? { b, w: widgets.length - 1 } : null;
}

const pendingConfig = ref<{ b: number; w: number } | null>(null);
function afterAddClosed() {
  const target = pendingConfig.value;
  pendingConfig.value = null;
  if (target) openConfig(target.b, target.w);
}

function openConfig(b: number, w: number) {
  configTarget.value = { b, w };
  configOpen.value = true;
}

function applyConfig(widget: DashboardWidget) {
  const t = configTarget.value;
  if (!t || !draft.value) return;
  draft.value.bands[t.b]!.widgets[t.w] = widget;
}

function widgetMenu(b: number, w: number) {
  const band = bandOf(b);
  const widget = band.widgets[w]!;
  const others = draft.value!.bands.map((x, i) => ({ x, i })).filter(({ i }) => i !== b);
  return [
    [
      {
        label: 'Configure',
        icon: 'i-lucide-settings-2',
        onSelect: () => openConfig(b, w),
        'data-tour': 'widget-configure',
      },
      {
        label: widget.size === 'full' ? 'Half width' : 'Full width',
        icon: 'i-lucide-move-horizontal',
        onSelect: () => toggleWidth(b, w),
      },
      { label: 'Move up', icon: 'i-lucide-arrow-up', disabled: w === 0, onSelect: () => moveWidget(b, w, -1) },
      {
        label: 'Move down',
        icon: 'i-lucide-arrow-down',
        disabled: w === band.widgets.length - 1,
        onSelect: () => moveWidget(b, w, 1),
      },
      ...(others.length > 0
        ? [
            {
              label: 'Move to band',
              icon: 'i-lucide-arrow-right-left',
              children: others.map(({ x, i }) => ({ label: x.title, onSelect: () => moveWidgetToBand(b, w, i) })),
            },
          ]
        : []),
      { label: 'Duplicate', icon: 'i-lucide-copy', onSelect: () => duplicateWidget(b, w) },
    ],
    [{ label: 'Remove', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => removeWidget(b, w) }],
  ];
}

function bandMenu(b: number) {
  const count = draft.value!.bands.length;
  return [
    [
      { label: 'Move band up', icon: 'i-lucide-arrow-up', disabled: b === 0, onSelect: () => moveBand(b, -1) },
      {
        label: 'Move band down',
        icon: 'i-lucide-arrow-down',
        disabled: b === count - 1,
        onSelect: () => moveBand(b, 1),
      },
    ],
    [{ label: 'Remove band', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => removeBand(b) }],
  ];
}

// ── Sharing, defaults, deletion ──────────────────────────────────────────────

const myDefault = useCookie<string | null>(MY_DEFAULT_DASHBOARD_COOKIE, { default: () => null });
const isMyDefault = computed(() => (myDefault.value ?? 'overview') === props.view.id);

function setMyDefault() {
  myDefault.value = props.view.id === 'overview' ? null : props.view.id;
  toast.add({ title: `${props.view.name} opens when you visit Analytics`, color: 'success' });
}

async function setInstanceDefault() {
  try {
    await $fetch('/api/settings/default-dashboard', { method: 'PUT', body: { dashboard: props.view.id } });
    toast.add({ title: `${props.view.name} is the default dashboard for everyone`, color: 'success' });
  } catch (error) {
    toast.add({ title: "Couldn't set the default dashboard", description: errorMessage(error), color: 'error' });
  }
}

async function setVisibility(visibility: 'private' | 'shared') {
  try {
    const saved = await $fetch<DashboardView>(`/api/dashboards/${props.view.id}`, {
      method: 'PATCH',
      body: { visibility, updatedAt: props.view.updatedAt },
    });
    emit('saved', saved);
    toast.add({ title: visibility === 'shared' ? 'Dashboard shared' : 'Dashboard made private', color: 'success' });
  } catch (error: any) {
    if (error?.statusCode === 409 || error?.response?.status === 409) conflictOpen.value = true;
    else toast.add({ title: "Couldn't change who sees it", description: errorMessage(error), color: 'error' });
  }
}

const renameOpen = ref(false);
async function onRenamed(saved: DashboardView) {
  emit('saved', saved);
  // The switcher lists every dashboard by name.
  await refreshNuxtData('analytics-dashboards');
}

const deleteOpen = ref(false);
async function confirmDelete() {
  try {
    await $fetch(`/api/dashboards/${props.view.id}`, { method: 'DELETE' });
    deleteOpen.value = false;
    toast.add({ title: 'Dashboard deleted', color: 'success' });
    if (myDefault.value === props.view.id) myDefault.value = null;
    await navigateTo('/analytics/dashboards');
  } catch (error) {
    toast.add({ title: "Couldn't delete the dashboard", description: errorMessage(error), color: 'error' });
  }
}

async function copyLink() {
  const url = new URL(window.location.href);
  url.searchParams.delete('tv');
  url.searchParams.delete('edit');
  if (url.pathname.replace(/\/$/, '').endsWith('/analytics') && !isOverview) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/d/${props.view.id}`;
  }
  await navigator.clipboard?.writeText(url.toString()).catch(() => {});
  toast.add({ title: 'Link copied', description: 'It opens this dashboard with the same scope.', color: 'success' });
}

function openTvMode() {
  void navigateTo({ path: `/analytics/d/${props.view.id}`, query: { ...route.query, tv: '1' } });
}

const headerActions = computed(() => {
  const actions: Array<Record<string, any>> = [];
  if (editing.value) {
    actions.push(
      { label: 'Cancel', icon: 'i-lucide-x', variant: 'ghost', color: 'neutral', onClick: cancelEditing },
      {
        label: 'Save as…',
        icon: 'i-lucide-copy-plus',
        variant: 'outline',
        color: 'neutral',
        title: 'Save these changes as a new dashboard',
        onClick: openSaveAs,
      },
      { label: 'Save', icon: 'i-lucide-save', color: 'primary', loading: saving.value, onClick: save },
    );
    return actions;
  }
  if (props.view.canEdit) {
    actions.push({
      label: 'Edit',
      icon: 'i-lucide-pencil',
      variant: 'outline',
      color: 'neutral',
      title: 'Edit this dashboard',
      onClick: startEditing,
      attrs: { 'data-tour': 'dashboard-edit' },
    });
  } else {
    actions.push({
      label: 'Duplicate',
      icon: 'i-lucide-copy',
      variant: 'outline',
      color: 'neutral',
      title: 'Save a copy of this dashboard you can edit',
      onClick: duplicate,
    });
  }
  if (!isHidden('quality-reports')) {
    actions.push({
      label: 'Export',
      icon: 'i-lucide-file-down',
      variant: 'outline',
      color: 'neutral',
      title: 'Export this scope as a quality report',
      onClick: () => (reportOpen.value = true),
      attrs: { 'data-tour': 'dashboard-export' },
    });
    if (canScheduleReports.value) {
      actions.push({
        label: 'Schedule…',
        icon: 'i-lucide-calendar-clock',
        variant: 'outline',
        color: 'neutral',
        title: 'Schedule a quality report of this scope',
        onClick: () => (scheduleOpen.value = true),
        attrs: { 'data-tour': 'dashboard-schedule' },
      });
    }
  }
  return actions;
});

const moreItems = computed(() => {
  const view = props.view;
  const first: Array<Record<string, any>> = [
    { label: 'Copy link', icon: 'i-lucide-link', onSelect: copyLink },
    { label: 'TV mode', icon: 'i-lucide-tv', onSelect: openTvMode },
  ];
  if (view.canEdit) first.push({ label: 'Duplicate', icon: 'i-lucide-copy', onSelect: duplicate });
  const defaults: Array<Record<string, any>> = [];
  if (!isMyDefault.value) defaults.push({ label: 'Make it my default', icon: 'i-lucide-home', onSelect: setMyDefault });
  if (props.list?.canSetDefault && view.visibility === 'shared' && props.list.instanceDefault !== view.id) {
    defaults.push({ label: 'Make it the default for everyone', icon: 'i-lucide-users', onSelect: setInstanceDefault });
  }
  const manage: Array<Record<string, any>> = [
    { label: 'Manage dashboards', icon: 'i-lucide-layout-dashboard', to: '/analytics/dashboards' },
  ];
  if (isSaved && !isDemoMode && canShareLinks.value) {
    manage.unshift({
      label: 'Live dashboard links',
      icon: 'i-lucide-cast',
      onSelect: () => (liveLinksOpen.value = true),
    });
  }
  if (isSaved && view.canEdit) {
    manage.unshift({ label: 'Rename…', icon: 'i-lucide-pencil-line', onSelect: () => (renameOpen.value = true) });
  }
  if (isSaved && view.canEdit && props.list?.canShare) {
    manage.unshift(
      view.visibility === 'shared'
        ? { label: 'Make private', icon: 'i-lucide-lock', onSelect: () => setVisibility('private') }
        : { label: 'Share with everyone', icon: 'i-lucide-share-2', onSelect: () => setVisibility('shared') },
    );
  }
  const danger =
    isSaved && view.canEdit
      ? [
          [
            {
              label: 'Delete',
              icon: 'i-lucide-trash-2',
              color: 'error' as const,
              onSelect: () => (deleteOpen.value = true),
            },
          ],
        ]
      : [];
  return [first, ...(defaults.length ? [defaults] : []), manage, ...danger];
});

const reportDashboard = computed(() => (props.view.kind === 'builtin' && !isOverview ? props.view.id : 'executive'));
const savedReportDashboard = computed(() => (isSaved ? { id: props.view.id, name: props.view.name } : null));

// ── Live refresh ─────────────────────────────────────────────────────────────

/** At most one refresh per widget in this window. */
const REFRESH_WINDOW_MS = 30_000;
const refreshCounts = reactive<Record<string, number>>({});
const lastRefresh = new Map<string, number>();
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>();

function bump(key: string) {
  lastRefresh.set(key, Date.now());
  pendingRefresh.delete(key);
  refreshCounts[key] = (refreshCounts[key] ?? 0) + 1;
}

function scheduleRefresh(key: string) {
  if (pendingRefresh.has(key)) return;
  const wait = (lastRefresh.get(key) ?? 0) + REFRESH_WINDOW_MS - Date.now();
  if (wait <= 0) bump(key);
  else
    pendingRefresh.set(
      key,
      setTimeout(() => bump(key), wait),
    );
}

/** Whether a finished run of `projectId` can change this widget. */
function widgetReads(widget: { scope?: Partial<AnalyticsScope> }, projectId: number): boolean {
  const ids = applyWidgetScope(scope.value, widget.scope).projectIds;
  return !ids || ids.length === 0 || ids.includes(projectId);
}

// `rollup-updated` follows a finished or submitted run once its day's rollup counts it; a refresh on
// the run events themselves would read the rollups before the run is in them.
useRunEvents((event) => {
  if (editing.value || event.type !== 'rollup-updated') return;
  if (typeof event.projectId !== 'number') return;
  for (const band of bands.value) {
    for (const widget of band.widgets) {
      if (widget.available && widgetReads(widget, event.projectId)) scheduleRefresh(widget.key);
    }
  }
});

onUnmounted(() => {
  for (const timer of pendingRefresh.values()) clearTimeout(timer);
});

// ── TV mode ──────────────────────────────────────────────────────────────────

/** TV mode refreshes every widget on this cadence, whether or not a run finished. */
const TV_REFRESH_MS = 5 * 60_000;
const MIN_ROTATION_SECONDS = 15;
const now = ref(Date.now());
let tvTimers: ReturnType<typeof setInterval>[] = [];

const cycle = computed(() =>
  String(route.query.cycle ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);
const rotateEvery = computed(() => Math.max(MIN_ROTATION_SECONDS, Number(route.query.every) || 60));

onMounted(() => {
  if (!props.tv) return;
  tvTimers.push(setInterval(() => (now.value = Date.now()), 30_000));
  tvTimers.push(
    setInterval(() => {
      for (const band of bands.value) for (const widget of band.widgets) bump(widget.key);
    }, TV_REFRESH_MS),
  );
  if (cycle.value.length > 1) {
    tvTimers.push(
      setInterval(() => {
        const at = cycle.value.indexOf(props.view.id);
        const next = cycle.value[(at + 1) % cycle.value.length]!;
        void navigateTo({
          path: `/analytics/d/${next}`,
          query: { tv: '1', cycle: cycle.value.join(','), every: String(rotateEvery.value) },
        });
      }, rotateEvery.value * 1000),
    );
  }
});

onUnmounted(() => {
  for (const timer of tvTimers) clearInterval(timer);
  tvTimers = [];
});

useHead(() => ({ htmlAttrs: { class: props.tv ? 'tv-mode' : '' } }));

function exitTvMode() {
  const { tv: _tv, cycle: _cycle, every: _every, ...rest } = route.query;
  void navigateTo({ path: route.path, query: rest });
}

// Coming back to the dashboard (from a test a widget links to) scrolls it to where the user left it.
useViewScroll(() => dashboardPanelBody('analytics'));
</script>

<template>
  <!-- TV mode: no navigation, larger type, its own refresh -->
  <div v-if="tv" class="min-h-dvh p-4 sm:p-6 space-y-6" data-testid="dashboard-tv">
    <header class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h1 class="text-lg sm:text-xl font-semibold text-highlighted">{{ view.name }}</h1>
        <p class="text-xs text-muted">
          {{ scopeSummary?.period.label }}
          <template v-if="hiddenProjects > 0">
            · {{ hiddenProjects }} {{ hiddenProjects === 1 ? 'project' : 'projects' }} hidden (no access)</template
          >
          <ClientOnly> · updated {{ new Date(now).toLocaleTimeString() }}</ClientOnly>
        </p>
      </div>
      <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-x" @click="exitTvMode">Exit TV mode</UButton>
    </header>
    <section v-for="band in bands" :key="band.title" class="space-y-3">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-dimmed">{{ band.title }}</h2>
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        <div v-for="widget in band.widgets" :key="widget.key" :class="widget.size === 'full' ? 'xl:col-span-2' : ''">
          <DashboardWidgetFrame
            :key="`${mode}-${widget.key}`"
            :widget="widget"
            :mode="mode"
            :dashboard-id="view.id"
            :scope="scope"
            :query="scopeQuery"
            :refresh="refreshCounts[widget.key] ?? 0"
            :test-filter-active="testFilterActive"
          />
        </div>
      </div>
    </section>
  </div>

  <UDashboardPanel v-else id="analytics">
    <template #header>
      <UDashboardNavbar data-tour="analytics-page">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UBreadcrumb
            class="hidden sm:flex"
            :items="[{ label: 'Analytics', icon: 'i-lucide-chart-line', to: '/analytics' }]"
          />
          <DashboardSwitcher :current="{ id: view.id, name: view.name }" :items="list?.items ?? []" />
        </template>
        <template #right>
          <NavbarActions :actions="headerActions as any">
            <UDropdownMenu v-if="!editing" :items="moreItems" :content="{ align: 'end' }">
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-ellipsis-vertical"
                aria-label="More dashboard actions"
                data-testid="dashboard-more"
              />
            </UDropdownMenu>
          </NavbarActions>
          <template v-if="!isHidden('quality-reports')">
            <ReportPreviewModal
              v-model:open="reportOpen"
              :query="scopeQuery"
              :dashboard="reportDashboard"
              :saved-dashboard="savedReportDashboard"
            />
            <ScheduleForm
              v-model:open="scheduleOpen"
              :scope="scopeQuery"
              :dashboard="isSaved ? view.id : reportDashboard"
            />
          </template>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="space-y-4" data-shot="dashboard" :data-dashboard="view.id">
        <p
          v-if="hiddenProjects > 0 || (isSaved && (view.description || view.ownerName))"
          class="text-xs text-muted"
          data-testid="dashboard-meta"
        >
          <template v-if="isSaved && view.description">{{ view.description }}</template>
          <template v-if="isSaved && view.ownerName">
            <template v-if="view.description"> · </template>{{ view.visibility === 'shared' ? 'Shared' : 'Private' }},
            by {{ view.ownerName }}</template
          >
          <span v-if="hiddenProjects > 0" data-testid="dashboard-hidden-projects" data-tour="dashboard-hidden-projects">
            <template v-if="isSaved && (view.description || view.ownerName)"> · </template>{{ hiddenProjects }}
            {{ hiddenProjects === 1 ? 'project' : 'projects' }} hidden (no access)
          </span>
          <HelpHint v-if="hiddenProjects > 0" topic="dashboards.hidden-projects" />
        </p>

        <UAlert
          v-if="editing"
          icon="i-lucide-pencil"
          color="neutral"
          variant="subtle"
          title="Editing this dashboard"
          description="Default filters are the filters the dashboard opens with. Widgets preview from your changes; nothing is saved until you click Save."
        />

        <AnalyticsScopeBar
          v-model="state"
          :title="editing ? 'Default filters' : 'Filters'"
          :available-projects="availableProjects"
          :available-environments="availableEnvironments"
          :available-branches="availableBranches"
          :summary="scopeSummary"
        />

        <UAlert
          v-if="windowHidesData"
          icon="i-lucide-calendar-off"
          color="warning"
          variant="subtle"
          :title="`No test runs in the selected period (${scopeSummary?.period.label ?? state.period})`"
          :description="`Your most recent run was ${formatRelativeTime(newestRunTime)} — the widgets below look empty because the selected range excludes it.`"
          :actions="[
            { label: 'Show all time', color: 'warning', variant: 'solid', size: 'xs', onClick: widenToAllTime },
          ]"
        />

        <section
          v-for="(band, b) in bands"
          :key="editing ? `band-${b}` : band.title"
          class="space-y-3"
          :data-testid="`band-${b}`"
        >
          <div v-if="editing && draft" class="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div class="flex-1 space-y-2 min-w-0">
              <UInput
                v-model="draft.bands[b]!.title"
                class="w-full"
                aria-label="Band title"
                :data-testid="`band-title-${b}`"
              />
              <UInput
                v-model="draft.bands[b]!.description"
                class="w-full"
                placeholder="Description (optional)"
                aria-label="Band description"
              />
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                icon="i-lucide-plus"
                :data-testid="`add-widget-button-${b}`"
                @click="openAdd(b)"
              >
                Add widget
              </UButton>
              <UDropdownMenu :items="bandMenu(b)" :content="{ align: 'end' }">
                <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-ellipsis" aria-label="Band actions" />
              </UDropdownMenu>
            </div>
          </div>
          <div v-else>
            <h2 class="text-sm font-semibold uppercase tracking-wide text-dimmed">{{ band.title }}</h2>
            <p v-if="band.description" class="text-sm text-muted">{{ band.description }}</p>
          </div>

          <p v-if="editing && band.widgets.length === 0" class="text-sm text-muted">
            No widget in this band yet: add one.
          </p>

          <div class="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
            <div
              v-for="(widget, w) in band.widgets"
              :key="widget.key"
              :class="widget.size === 'full' ? 'xl:col-span-2' : ''"
              :data-testid="`widget-${widget.key}`"
            >
              <div v-if="editing" class="flex items-center justify-between gap-2 mb-1">
                <span class="text-xs text-muted truncate">
                  {{ widget.title }} · {{ widget.size === 'full' ? 'full width' : 'half width' }}
                </span>
                <UDropdownMenu :items="widgetMenu(b, w)" :content="{ align: 'end' }">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-ellipsis"
                    :aria-label="`Widget actions: ${widget.title}`"
                    :data-testid="`widget-menu-${widget.key}`"
                    data-tour="widget-menu"
                  />
                </UDropdownMenu>
              </div>
              <DashboardWidgetFrame
                :key="`${mode}-${widget.key}`"
                :widget="widget"
                :mode="mode"
                :dashboard-id="view.id"
                :scope="scope"
                :query="scopeQuery"
                :refresh="refreshCounts[widget.key] ?? 0"
                :test-filter-active="testFilterActive"
              />
            </div>
          </div>
        </section>

        <UButton
          v-if="editing"
          color="neutral"
          variant="outline"
          icon="i-lucide-plus"
          data-testid="add-band"
          @click="addBand"
        >
          Add band
        </UButton>
      </div>

      <AddWidgetSlideover
        v-if="editing"
        v-model:open="addOpen"
        :band-title="addTarget !== null ? (draft?.bands[addTarget]?.title ?? '') : ''"
        @add="addWidget"
        @closed="afterAddClosed"
      />
      <WidgetConfigSlideover
        v-if="editing"
        v-model:open="configOpen"
        :widget="configWidget"
        :projects="availableProjects ?? []"
        @apply="applyConfig"
      />

      <UModal
        v-model:open="conflictOpen"
        title="Saved by someone else"
        description="This dashboard was saved since you opened it. Reload it to see their version, or save yours as a copy."
      >
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              label="Reload"
              data-testid="conflict-reload"
              @click="reloadAfterConflict"
            />
            <UButton color="primary" label="Save as a copy" data-testid="conflict-save-copy" @click="openSaveAs" />
          </div>
        </template>
      </UModal>

      <UModal v-model:open="saveAsOpen" title="Save as a new dashboard">
        <template #body>
          <UFormField label="Name" required>
            <UInput v-model="saveAsName" class="w-full" data-testid="save-as-name" @keydown.enter="saveAs" />
          </UFormField>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" label="Cancel" @click="saveAsOpen = false" />
            <UButton color="primary" label="Save" :loading="saving" data-testid="save-as-confirm" @click="saveAs" />
          </div>
        </template>
      </UModal>

      <DeleteDashboardModal v-model:open="deleteOpen" :dashboard="view" @confirm="confirmDelete" />
      <RenameDashboardModal v-if="isSaved" v-model:open="renameOpen" :dashboard="view" @saved="onRenamed" />
      <ShareLinksModal
        v-if="isSaved && !isDemoMode"
        v-model:open="liveLinksOpen"
        kind="dashboard"
        :trigger="false"
        :endpoint="`/api/dashboards/${view.id}/share-links`"
      />
    </template>
  </UDashboardPanel>
</template>
