<script setup lang="ts">
/**
 * The project's locators: check some locators against the ones its tests use,
 * and browse every chain in the locator index. The Piwi Picker extension links
 * here with the locators of a picked element in `?q=`, one per line. `?branch=`
 * picks the branch described (`*` for every branch), the default branch when
 * absent. `?stability=brittle` or `watch` lists only the chains the locator
 * stability rules flag, and `?page=/checkout` only the chains tests used on
 * that page.
 */
import type { ProjectDetails } from '~~/types/api';
import type { LocatorIndex } from '#shared/locator-index';
import type { ExecutionLocatorUse } from '#shared/locator-usages.types';
import { locatorScopes, locatorTarget, tryParseLocatorChain } from '#shared/locator-chain';
import { ALL_BRANCHES } from '#shared/locator-index';
import { parseLocatorStabilityFilter } from '~/utils/locator-stability';
import { ALL_PAGES } from '~/utils/locator-pages';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id as string;

const { data: project, error: projectError } = await useFetch<ProjectDetails>(`/api/projects/${projectId}`);
if (projectError.value) showPageLoadError(projectError.value, 'project');

/** The select's value for the default branch: a colon is never part of a git branch name. */
const DEFAULT_BRANCH = ':default';
const branch = ref(typeof route.query.branch === 'string' && route.query.branch ? route.query.branch : DEFAULT_BRANCH);
const branchQuery = computed(() => (branch.value === DEFAULT_BRANCH ? undefined : branch.value));
watch(branchQuery, (value) => void router.replace({ query: { ...route.query, branch: value } }));

// Client-side only: the index can be large, and it has no place in the SSR payload.
const {
  data: index,
  status,
  error,
} = useFetch<LocatorIndex>(`/api/projects/${projectId}/locator-index`, {
  server: false,
  lazy: true,
  query: computed(() => (branchQuery.value ? { branch: branchQuery.value } : {})),
});

const branchItems = computed(() => {
  const defaultName = index.value?.defaultBranch;
  const items = [
    { label: defaultName ? `${defaultName} (default branch)` : 'Default branch', value: DEFAULT_BRANCH },
    { label: 'All branches', value: ALL_BRANCHES },
    ...(index.value?.branches ?? []).map((b) => ({ label: b.name, value: b.name })),
  ];
  if (!items.some((item) => item.value === branch.value)) items.push({ label: branch.value, value: branch.value });
  return items;
});

const branchHint = computed(() => {
  const i = index.value;
  if (!i) return '';
  if (i.branch === null) return 'Uses recorded on any branch.';
  if (i.branch === i.defaultBranch) return `Uses recorded on ${i.defaultBranch}.`;
  return `Tests that ran on ${i.branch} count with what they did there, the others with what they do on ${i.defaultBranch}.`;
});

useHead(
  computed(() => ({
    title: `Locators — ${project.value?.label || project.value?.name || 'Project'} — Piwi Dashboard`,
  })),
);

const loading = computed(() => status.value === 'idle' || status.value === 'pending');

const pasted = ref(typeof route.query.q === 'string' ? route.query.q : '');
let syncTimer: ReturnType<typeof setTimeout> | undefined;
watch(pasted, (value) => {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void router.replace({ query: { ...route.query, q: value.trim() ? value : undefined } });
  }, 400);
});
onBeforeUnmount(() => clearTimeout(syncTimer));

const stability = ref(parseLocatorStabilityFilter(route.query.stability));
watch(stability, (value) => {
  void router.replace({ query: { ...route.query, stability: value === 'all' ? undefined : value } });
});

const pageFilter = ref(typeof route.query.page === 'string' ? route.query.page : ALL_PAGES);
watch(pageFilter, (value) => {
  void router.replace({ query: { ...route.query, page: value === ALL_PAGES ? undefined : value } });
});

const drawerOpen = ref(false);
const drawerUse = ref<ExecutionLocatorUse | null>(null);

/** Open "Who uses this?" for a chain of the index. */
function inspect(locator: string) {
  const entry = index.value?.locators.find((e) => e.locator === locator);
  const chain = tryParseLocatorChain(locator);
  const counts = new Map<string, number>();
  for (const action of entry?.uses.flatMap((u) => u.actions) ?? []) counts.set(action, (counts.get(action) ?? 0) + 1);
  const action = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
  drawerUse.value = {
    stepIndex: 0,
    occurrences: 1,
    action,
    locator,
    target: chain ? locatorTarget(chain) : locator,
    scopes: chain ? locatorScopes(chain) : [],
    callSite: entry?.uses[0]?.callSites[0] ?? null,
    sameLocatorTests: entry ? new Set(entry.uses.map((u) => u.test)).size : 0,
    sameTargetTests: 0,
  };
  drawerOpen.value = true;
}

useViewScroll(() => dashboardPanelBody('project-locators'));
</script>

<template>
  <UDashboardPanel id="project-locators">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav
            :items="[
              { label: 'Home', icon: 'i-lucide-house', to: '/' },
              { label: 'Projects', to: '/projects' },
              { label: project?.label || project?.name || 'Project', to: `/projects/${projectId}` },
              { label: 'Locators' },
            ]"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-4 space-y-4">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center" data-shot="locator-branch">
          <USelect
            v-model="branch"
            :items="branchItems"
            icon="i-lucide-git-branch"
            size="sm"
            class="w-full sm:w-72"
            aria-label="Branch"
          />
          <p class="text-xs text-muted">{{ branchHint }}</p>
        </div>

        <SectionCard title="Check locators" icon="i-lucide-scan-search" help="project.locator-check">
          <template #subtitle>
            Find the tests that use some locators: the ones the
            <DocLink to="features/extension" no-icon :class="SENTENCE_LINK_CLASS">Piwi Picker extension</DocLink>
            gives for an element, or lines copied from a test.
          </template>
          <LoadingState v-if="loading" text="Loading the locator index…" />
          <ErrorState v-else-if="error" text="Could not load the locator index." />
          <ProjectLocatorCheck v-else-if="index" v-model="pasted" :index="index" @inspect="inspect" />
          <PickerInstallHint
            v-if="index && !pasted.trim()"
            class="mt-3"
            text="Pick an element on your live page and it opens its ranked locators here, to check them against your tests."
          />
        </SectionCard>

        <SectionCard
          title="Locators your tests use"
          icon="i-lucide-crosshair"
          :count="index?.locators.length ?? null"
          help="project.locator-index"
        >
          <template #subtitle>Read from the steps of every run, the chains shared by the most tests first.</template>
          <LoadingState v-if="loading" text="Loading the locator index…" />
          <ErrorState v-else-if="error" text="Could not load the locator index." />
          <EmptyState
            v-else-if="index && index.locators.length === 0"
            icon="i-lucide-crosshair"
            text="No locator recorded yet: the index fills in from the steps of the runs the reporter sends."
          />
          <ProjectLocatorList
            v-else-if="index"
            v-model:stability="stability"
            v-model:page="pageFilter"
            :index="index"
            @inspect="inspect"
          />
        </SectionCard>
      </div>

      <LocatorUsageDrawer
        v-model:open="drawerOpen"
        :use="drawerUse"
        :project-id="Number(projectId)"
        :project-key="projectId"
        :project-name="project?.name"
        :branch="branchQuery"
      />
    </template>
  </UDashboardPanel>
</template>
