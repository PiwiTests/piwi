<script setup lang="ts">
/**
 * A dashboard page: a built-in dashboard is known without a request; a saved
 * one is loaded for the viewer (a private dashboard of someone else reads as
 * not found). Shared by `/analytics` and `/analytics/d/[id]`.
 */
import type { DashboardList, DashboardView } from '#shared/handlers/dashboards';

const props = defineProps<{ dashboardId: string; list: DashboardList | null }>();

const route = useRoute();
const tv = computed(() => route.query.tv === '1');
const requestFetch = useRequestFetch();

const builtin = builtinDashboardView(props.dashboardId);
const { data: saved, error } = await useAsyncData<DashboardView | null>(
  `analytics-dashboard-${props.dashboardId}`,
  () => (builtin ? Promise.resolve(null) : requestFetch<DashboardView>(`/api/dashboards/${props.dashboardId}`)),
);
const view = ref<DashboardView | null>(builtin ?? saved.value ?? null);
watch(saved, (value) => {
  if (value && !builtin) view.value = value;
});

useHead(() => ({ title: `${view.value?.name ?? 'Dashboard'} - Analytics - Piwi` }));
</script>

<template>
  <DashboardBody v-if="view" :key="view.id" :view="view" :list="list" :tv="tv" @saved="view = $event" />
  <UDashboardPanel v-else id="analytics">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <UBreadcrumb :items="[{ label: 'Analytics', icon: 'i-lucide-chart-line', to: '/analytics' }]" />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <ErrorState v-if="error" :text="`This dashboard does not exist, or it is private: ${errorMessage(error)}`">
        <template #action>
          <UButton size="sm" color="neutral" variant="outline" to="/analytics">Open Analytics</UButton>
        </template>
      </ErrorState>
      <LoadingState v-else />
    </template>
  </UDashboardPanel>
</template>
