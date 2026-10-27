<script setup lang="ts">
import type { ReportScheduleView, ReportSnapshotSummary } from '#shared/handlers/reports';

useHead({ title: 'Quality reports - Piwi Dashboard' });

// Report schedules need `report:write`; the list holds every project's, so any project is enough.
const { canAnywhere } = useAuth();
const canSchedule = computed(() => canAnywhere('report:write'));
const { isHidden } = await useInstanceCapabilities();
const isDesktop = useIsDesktop();
const demoMode = !!useRuntimeConfig().public.demoMode;

const {
  data: snapshots,
  status: snapshotsStatus,
  error: snapshotsError,
  refresh: refreshSnapshots,
} = await useFetch<{ items: ReportSnapshotSummary[] }>('/api/reports/snapshots', {
  server: false,
  lazy: true,
  default: () => ({ items: [] }),
});

const {
  data: schedules,
  status: schedulesStatus,
  error: schedulesError,
  refresh: refreshSchedules,
} = await useFetch<{ items: ReportScheduleView[] }>('/api/reports/schedules', {
  server: false,
  lazy: true,
  immediate: canSchedule.value,
  default: () => ({ items: [] }),
});

// Both lists load client-side only, so the server renders them `idle`: idle reads as
// loading too, and the first client render matches the server's.
const snapshotsLoading = computed(() => snapshotsStatus.value === 'idle' || snapshotsStatus.value === 'pending');
const schedulesLoading = computed(() => schedulesStatus.value === 'idle' || schedulesStatus.value === 'pending');

const formOpen = ref(false);
const editing = ref<ReportScheduleView | null>(null);

function newSchedule() {
  editing.value = null;
  formOpen.value = true;
}

function editSchedule(schedule: ReportScheduleView) {
  editing.value = schedule;
  formOpen.value = true;
}

function refreshAll() {
  void refreshSchedules();
  void refreshSnapshots();
}

const schedulesSubtitle = computed(() => {
  if (demoMode) return 'The demo has no scheduler: a schedule is stored in your browser and never fires by itself.';
  if (isDesktop) return 'A schedule fires while the desktop app is running.';
  return 'Each schedule sends a quality report to its channels and keeps it as a snapshot.';
});

useViewScroll(() => dashboardPanelBody('reports'));
</script>

<template>
  <UDashboardPanel id="reports">
    <template #header>
      <UDashboardNavbar data-tour="reports-page">
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav :items="[{ label: 'Quality reports', icon: 'i-lucide-file-chart-column', to: '/reports' }]" />
        </template>
        <template v-if="canSchedule && !isHidden('quality-reports')" #right>
          <NavbarActions
            :actions="[
              {
                label: 'New schedule',
                icon: 'i-lucide-calendar-plus',
                color: 'primary',
                title: 'Schedule a quality report',
                onClick: newSchedule,
                attrs: { 'data-tour': 'new-schedule' },
              },
            ]"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <EmptyState
        v-if="isHidden('quality-reports')"
        icon="i-lucide-circle-slash"
        text="Quality reports are turned off on this instance. An administrator can turn them back on in Settings."
      />
      <div v-else class="space-y-4 max-w-4xl" data-shot="reports-page">
        <SectionCard
          icon="i-lucide-files"
          title="Report snapshots"
          :count="snapshots.items.length || undefined"
          subtitle="Every quality report generated, kept with its numbers as they were."
          help="reports.snapshots"
          data-tour="report-snapshots"
        >
          <LoadingState v-if="snapshotsLoading && snapshots.items.length === 0" />
          <ErrorState
            v-else-if="snapshotsError"
            :text="`Couldn't load the report snapshots: ${errorMessage(snapshotsError)}`"
          />
          <EmptyState
            v-else-if="snapshots.items.length === 0"
            icon="i-lucide-file-chart-column"
            text="No quality report kept yet. A schedule keeps one each time it fires; Run now keeps one straight away."
          />
          <SnapshotList v-else :snapshots="snapshots.items" />
        </SectionCard>

        <SectionCard
          v-if="canSchedule"
          icon="i-lucide-calendar-clock"
          title="Report schedules"
          data-tour="report-schedules"
          :count="schedules.items.length || undefined"
          :subtitle="schedulesSubtitle"
          help="reports.schedule"
        >
          <LoadingState v-if="schedulesLoading && schedules.items.length === 0" />
          <ErrorState
            v-else-if="schedulesError"
            :text="`Couldn't load the report schedules: ${errorMessage(schedulesError)}`"
          />
          <EmptyState
            v-else-if="schedules.items.length === 0"
            icon="i-lucide-calendar-clock"
            text="No report schedule yet. Schedule… on the analytics or a project page starts one with that scope."
          >
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-calendar-plus" @click="newSchedule">
              New schedule
            </UButton>
          </EmptyState>
          <ScheduleList v-else :schedules="schedules.items" @changed="refreshAll" @edit="editSchedule" />
        </SectionCard>
      </div>
      <ScheduleForm v-model:open="formOpen" :schedule="editing" @saved="refreshAll" />
    </template>
  </UDashboardPanel>
</template>
