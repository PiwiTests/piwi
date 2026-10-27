<script setup lang="ts">
/**
 * `/analytics/dashboards`: every dashboard the viewer can open, grouped as
 * the switcher groups them, with *New dashboard*, rename, duplicate, delete,
 * the viewer's default and, for administrators, the instance default.
 */
import type { DashboardSummary, DashboardView } from '#shared/handlers/dashboards';

useHead({ title: 'Dashboards - Analytics - Piwi Dashboard' });

const toast = useToast();
const { data: list, refresh } = await useDashboardList();
const myDefault = useCookie<string | null>(MY_DEFAULT_DASHBOARD_COOKIE, { default: () => null });

interface DashboardGroup {
  label: string;
  hint?: string;
  items: DashboardSummary[];
}

/** The built-in dashboards, then the saved ones by group; an empty group is left out. */
const groups = computed(() => {
  const items = list.value?.items ?? [];
  const listed = (all: DashboardGroup[]) => all.filter((g) => g.items.length > 0);
  return {
    builtIn: listed([{ label: 'Built-in', items: items.filter((d) => d.kind === 'builtin') }]),
    saved: listed([
      { label: 'Shared', items: items.filter((d) => d.kind === 'saved' && d.visibility === 'shared' && !d.unused) },
      { label: 'Personal', items: items.filter((d) => d.kind === 'saved' && d.visibility === 'private') },
      {
        label: 'Unused',
        hint: 'Shared dashboards nobody opened for 90 days.',
        items: items.filter((d) => d.kind === 'saved' && d.unused),
      },
    ]),
  };
});

/** One group's list, the same for the built-in and the saved dashboards. */
const [DefineGroup, ReuseGroup] = createReusableTemplate<{ group: DashboardGroup }>();

function facts(d: DashboardSummary): string {
  const parts: string[] = [];
  if (d.kind === 'saved') parts.push(d.visibility === 'shared' ? 'Shared' : 'Private');
  if (d.ownerName && !d.mine) parts.push(`by ${d.ownerName}`);
  parts.push(`${d.widgetCount} ${d.widgetCount === 1 ? 'widget' : 'widgets'}`);
  if ((myDefault.value ?? 'overview') === d.id) parts.push('your default');
  if ((list.value?.instanceDefault ?? 'overview') === d.id) parts.push('default for everyone');
  return parts.join(' · ');
}

// ── New dashboard ────────────────────────────────────────────────────────────

const newOpen = ref(false);
const newName = ref('');
/** The start-from item of an empty dashboard (a select item cannot carry an empty value). */
const EMPTY = 'empty';
const newFrom = ref(EMPTY);
const newShared = ref(false);
const creating = ref(false);
const fromItems = computed(() => [
  { label: 'An empty dashboard', value: EMPTY },
  ...(list.value?.items ?? []).map((d) => ({ label: `A copy of ${d.name}`, value: d.id })),
]);

function openNew() {
  newName.value = '';
  newFrom.value = EMPTY;
  newShared.value = false;
  newOpen.value = true;
}

async function create() {
  if (!newName.value.trim()) return;
  creating.value = true;
  try {
    const created = await $fetch<DashboardView>('/api/dashboards', {
      method: 'POST',
      body: {
        name: newName.value.trim(),
        visibility: newShared.value ? 'shared' : 'private',
        ...(newFrom.value !== EMPTY ? { from: newFrom.value } : {}),
      },
    });
    newOpen.value = false;
    await navigateTo(`/analytics/d/${created.id}?edit=1`);
  } catch (error) {
    toast.add({ title: "Couldn't create the dashboard", description: errorMessage(error), color: 'error' });
  } finally {
    creating.value = false;
  }
}

// ── Row actions ──────────────────────────────────────────────────────────────

async function duplicate(d: DashboardSummary) {
  try {
    const copy = await $fetch<DashboardView>(`/api/dashboards/${d.id}/duplicate`, {
      method: 'POST',
      body: {},
    });
    await navigateTo(`/analytics/d/${copy.id}?edit=1`);
  } catch (error) {
    toast.add({ title: "Couldn't duplicate the dashboard", description: errorMessage(error), color: 'error' });
  }
}

function setMyDefault(d: DashboardSummary) {
  myDefault.value = d.id === 'overview' ? null : d.id;
  toast.add({ title: `${d.name} opens when you visit Analytics`, color: 'success' });
}

const instanceDefault = computed({
  get: () => list.value?.instanceDefault ?? 'overview',
  set: (value: string) => void setInstanceDefault(value),
});
const instanceDefaultItems = computed(() =>
  (list.value?.items ?? [])
    .filter((d) => d.kind === 'builtin' || d.visibility === 'shared')
    .map((d) => ({ label: d.name, value: d.id })),
);

async function setInstanceDefault(id: string) {
  try {
    await $fetch('/api/settings/default-dashboard', {
      method: 'PUT',
      body: { dashboard: id === 'overview' ? null : id },
    });
    await refresh();
    toast.add({ title: 'Default dashboard saved', color: 'success' });
  } catch (error) {
    toast.add({ title: "Couldn't set the default dashboard", description: errorMessage(error), color: 'error' });
  }
}

const renaming = ref<DashboardSummary | null>(null);
const renameOpen = ref(false);

function askRename(d: DashboardSummary) {
  renaming.value = d;
  renameOpen.value = true;
}

const deleting = ref<DashboardView | null>(null);
const deleteOpen = ref(false);

async function askDelete(d: DashboardSummary) {
  try {
    deleting.value = await $fetch<DashboardView>(`/api/dashboards/${d.id}`);
    deleteOpen.value = true;
  } catch (error) {
    toast.add({ title: "Couldn't open the dashboard", description: errorMessage(error), color: 'error' });
  }
}

async function confirmDelete() {
  const d = deleting.value;
  if (!d) return;
  try {
    await $fetch(`/api/dashboards/${d.id}`, { method: 'DELETE' });
    if (myDefault.value === d.id) myDefault.value = null;
    deleteOpen.value = false;
    await refresh();
    toast.add({ title: 'Dashboard deleted', color: 'success' });
  } catch (error) {
    toast.add({ title: "Couldn't delete the dashboard", description: errorMessage(error), color: 'error' });
  }
}

function rowMenu(d: DashboardSummary) {
  const items: Array<Record<string, any>> = [];
  if (d.kind === 'saved' && d.canEdit) {
    items.push({ label: 'Rename…', icon: 'i-lucide-pencil-line', onSelect: () => askRename(d) });
  }
  items.push({ label: 'Duplicate', icon: 'i-lucide-copy', onSelect: () => duplicate(d) });
  if ((myDefault.value ?? 'overview') !== d.id) {
    items.push({ label: 'Make it my default', icon: 'i-lucide-home', onSelect: () => setMyDefault(d) });
  }
  return [
    items,
    ...(d.kind === 'saved' && d.canEdit
      ? [[{ label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => askDelete(d) }]]
      : []),
  ];
}
</script>

<template>
  <UDashboardPanel id="analytics-dashboards">
    <template #header>
      <UDashboardNavbar data-tour="dashboards-page">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UBreadcrumb
            :items="[
              { label: 'Analytics', icon: 'i-lucide-chart-line', to: '/analytics' },
              { label: 'Dashboards', to: '/analytics/dashboards' },
            ]"
          />
        </template>
        <template #right>
          <NavbarActions
            :actions="[
              {
                label: 'New dashboard',
                icon: 'i-lucide-plus',
                color: 'primary',
                title: 'Create a dashboard, empty or from another one',
                onClick: openNew,
                attrs: { 'data-tour': 'new-dashboard' },
              },
            ]"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="space-y-4 max-w-4xl" data-shot="dashboards-list">
        <SectionCard
          v-if="list?.canSetDefault"
          icon="i-lucide-home"
          title="Default for everyone"
          help="dashboards.default"
          data-tour="default-dashboard"
        >
          <p class="text-sm text-highlighted leading-relaxed mb-2">
            The dashboard Analytics opens for everyone who has not picked their own.
          </p>
          <USelect
            v-model="instanceDefault"
            :items="instanceDefaultItems"
            class="w-full sm:w-72"
            aria-label="Default dashboard for everyone"
            data-testid="instance-default-dashboard"
          />
        </SectionCard>

        <DefineGroup v-slot="{ group }">
          <section class="space-y-1">
            <h2 class="text-xs font-medium text-muted">{{ group.label }}</h2>
            <p v-if="group.hint" class="text-xs text-muted">{{ group.hint }}</p>
            <ul class="divide-y divide-default" :data-testid="`dashboards-${group.label.toLowerCase()}`">
              <li
                v-for="d in group.items"
                :key="d.id"
                class="py-3 flex items-start gap-2"
                :data-testid="`dashboard-row-${d.id}`"
              >
                <div class="min-w-0 flex-1 space-y-0.5">
                  <NuxtLink
                    :to="`/analytics/d/${d.id}`"
                    class="text-sm font-medium text-highlighted break-words underline decoration-dotted underline-offset-2 hover:decoration-solid"
                  >
                    {{ d.name }}
                  </NuxtLink>
                  <p v-if="d.description" class="text-xs text-muted break-words">{{ d.description }}</p>
                  <p class="text-xs text-muted">
                    {{ facts(d) }}
                    <ClientOnly v-if="d.lastViewedAt"> · opened {{ formatRelativeTime(d.lastViewedAt) }}</ClientOnly>
                  </p>
                </div>
                <UDropdownMenu :items="rowMenu(d)" :content="{ align: 'end' }">
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-ellipsis"
                    :aria-label="`Actions: ${d.name}`"
                  />
                </UDropdownMenu>
              </li>
            </ul>
          </section>
        </DefineGroup>
        <ReuseGroup v-for="group in groups.builtIn" :key="group.label" :group="group" />
        <!-- The dashboards people saved, which the demo's guided tour points at -->
        <div v-if="groups.saved.length > 0" class="space-y-6" data-tour="team-dashboards">
          <ReuseGroup v-for="group in groups.saved" :key="group.label" :group="group" />
        </div>
      </div>

      <UModal v-model:open="newOpen" title="New dashboard">
        <template #body>
          <form class="space-y-4" data-testid="new-dashboard" @submit.prevent="create">
            <UFormField label="Name" required>
              <UInput v-model="newName" class="w-full" placeholder="Checkout team" data-testid="new-dashboard-name" />
            </UFormField>
            <UFormField label="Start from">
              <USelect v-model="newFrom" :items="fromItems" class="w-full" aria-label="Start from" />
            </UFormField>
            <div v-if="list?.canShare" class="flex items-center gap-1">
              <USwitch v-model="newShared" label="Share with everyone" />
              <HelpHint topic="dashboards.sharing" />
            </div>
          </form>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" label="Cancel" @click="newOpen = false" />
            <UButton
              color="primary"
              label="Create"
              :loading="creating"
              data-testid="new-dashboard-create"
              @click="create"
            />
          </div>
        </template>
      </UModal>

      <RenameDashboardModal v-model:open="renameOpen" :dashboard="renaming" @saved="refresh()" />
      <DeleteDashboardModal v-model:open="deleteOpen" :dashboard="deleting" @confirm="confirmDelete" />
    </template>
  </UDashboardPanel>
</template>
