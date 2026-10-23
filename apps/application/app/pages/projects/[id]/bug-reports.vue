<script setup lang="ts">
/**
 * A project's bug reports, newest first: the bugs Piwi Picker sent with
 * **Send to Piwi…**. `?status=` keeps one status.
 */
import type { ProjectDetails } from '~~/types/api';
import type { BugReportListItem } from '#shared/handlers/bug-reports';
import { BUG_REPORT_STATUS, BUG_REPORT_STATUS_ITEMS, verdictLabel } from '~/utils/bug-reports';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id as string;

const { data: project, error: projectError } = await useFetch<ProjectDetails>(`/api/projects/${projectId}`);
if (projectError.value) showPageLoadError(projectError.value, 'project');

const status = ref(typeof route.query.status === 'string' && route.query.status ? route.query.status : 'all');
watch(
  status,
  (value) => void router.replace({ query: { ...route.query, status: value === 'all' ? undefined : value } }),
);

const {
  data,
  status: fetchStatus,
  error,
} = useFetch<{ items: BugReportListItem[] }>(`/api/projects/${projectId}/bug-reports`, {
  server: false,
  lazy: true,
  query: computed(() => (status.value === 'all' ? {} : { status: status.value })),
});
const loading = computed(() => fetchStatus.value === 'idle' || fetchStatus.value === 'pending');
const items = computed(() => data.value?.items ?? []);

useHead(
  computed(() => ({
    title: `Bug reports — ${project.value?.label || project.value?.name || 'Project'} — Piwi Dashboard`,
  })),
);
</script>

<template>
  <UDashboardPanel id="project-bug-reports">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav
            :items="[
              { label: 'Home', icon: 'i-lucide-house', to: '/' },
              { label: 'Projects', to: '/projects' },
              { label: project?.label || project?.name || 'Project', to: `/projects/${projectId}` },
              { label: 'Bug reports' },
            ]"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <CapabilityDeclinedGuard capability="bug-reports" label="Bug reports">
        <div class="p-4 space-y-4">
          <SectionCard
            title="Bug reports"
            icon="i-lucide-bug"
            :count="loading ? null : items.length"
            help="project.bug-reports"
            data-shot="bug-report-list"
            data-tour="bug-report-list"
          >
            <template #subtitle>
              Sent from the
              <DocLink to="features/report-a-bug" no-icon :class="SENTENCE_LINK_CLASS">Piwi Picker extension</DocLink>
              with their steps, the expected result and evidence.
            </template>
            <template #actions>
              <USelect
                v-model="status"
                :items="BUG_REPORT_STATUS_ITEMS"
                size="sm"
                class="w-full sm:w-44"
                aria-label="Status"
              />
            </template>
            <LoadingState v-if="loading" text="Loading bug reports…" />
            <ErrorState v-else-if="error" text="Could not load the bug reports." />
            <EmptyState
              v-else-if="items.length === 0"
              icon="i-lucide-bug"
              :text="
                status === 'all'
                  ? 'No bug report yet: report one from Piwi Picker’s Report a bug, then Send to Piwi.'
                  : 'No bug report with this status.'
              "
            >
              <PickerInstallHint
                v-if="status === 'all'"
                class="max-w-md"
                text="Reproduce a bug on your page, and it sends the report here with its steps and evidence."
              />
            </EmptyState>
            <ul v-else class="divide-y divide-default -my-2">
              <li v-for="item in items" :key="item.id" class="flex items-start gap-3 py-2.5">
                <div class="min-w-0 flex-1">
                  <NuxtLink
                    :to="`/bug-reports/${item.id}`"
                    class="text-sm font-semibold text-highlighted hover:underline break-words"
                  >
                    {{ item.title }}
                  </NuxtLink>
                  <p class="text-xs text-muted mt-0.5 break-words">
                    #{{ item.id }}
                    <template v-if="item.path">
                      · <span class="font-mono">{{ item.path }}</span></template
                    >
                    <template v-if="item.reportedBy"> · {{ item.reportedBy }}</template>
                    · <span :title="prettyDateFormat(item.createdAt)">{{ formatRelativeTime(item.createdAt) }}</span>
                    <template v-if="item.lastVerdict">
                      · {{ verdictLabel(item.lastVerdict) }} ({{ item.reproductions }}
                      {{ item.reproductions === 1 ? 'try' : 'tries' }})
                    </template>
                  </p>
                </div>
                <UBadge
                  :color="BUG_REPORT_STATUS[item.status].color"
                  variant="subtle"
                  class="shrink-0"
                  :title="BUG_REPORT_STATUS[item.status].hint"
                >
                  {{ BUG_REPORT_STATUS[item.status].label }}
                </UBadge>
              </li>
            </ul>
          </SectionCard>
        </div>
      </CapabilityDeclinedGuard>
    </template>
  </UDashboardPanel>
</template>
