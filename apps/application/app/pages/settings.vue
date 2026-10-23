<script setup lang="ts">
import { SETTINGS_GROUPS, SETTINGS_PAGES } from '~/utils/settings-metadata';

useHead({ title: 'Settings — Piwi Dashboard' });

const { envManaged } = useSettingsEnvState();

// Already grouped (Instance / Analysis / meta): the vertical menu and the select below.
// Documentation is not a settings page — it lives in Settings → About →
// Resources and behind every inline-help "Learn more" link.
const navItems = await useSettingsNav(envManaged);

const route = useRoute();

// Below `lg`: a full-width select replaces the vertical menu. It keeps the same
// Instance / Analysis grouping (a `label` row heads each section) and is driven
// by the current route. Built from the registry so labels and order match the
// menu, filtered to the pages this viewer can actually see.
type SettingsSelectItem = { label: string; type?: 'label'; icon?: string; value?: string };

const selectItems = computed<SettingsSelectItem[]>(() => {
  const visible = new Set(navItems.value.flat().map((item) => item.to as string));
  const items: SettingsSelectItem[] = [];
  for (const group of SETTINGS_GROUPS) {
    const pages = SETTINGS_PAGES.filter((page) => page.group === group.id && visible.has(page.to));
    if (!pages.length) continue;
    if (group.label) items.push({ type: 'label', label: group.label });
    for (const page of pages) items.push({ label: page.label, icon: page.icon, value: page.to });
  }
  return items;
});

const currentPage = computed({
  get: () => route.path,
  set: (to: string) => {
    if (to && to !== route.path) navigateTo(to);
  },
});

const currentIcon = computed(() => SETTINGS_PAGES.find((page) => page.to === route.path)?.icon);

// From `lg` up, the same sections as a vertical menu beside the page, as in a
// project's Settings tab: a horizontal strip no longer fits the number of pages.
// Each section is headed by its group label (the meta group has none).
const menuItems = computed(() =>
  navItems.value.map((section) => {
    const group = SETTINGS_PAGES.find((page) => page.to === section[0]?.to)?.group;
    const label = SETTINGS_GROUPS.find((g) => g.id === group)?.label;
    return label ? [{ type: 'label' as const, label }, ...section] : section;
  }),
);
</script>

<template>
  <UDashboardPanel id="settings" :ui="{ body: 'lg:py-8' }">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <UBreadcrumb :items="[{ label: 'Home', icon: 'i-lucide-house', to: '/' }, { label: 'Settings' }]" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8 w-full lg:max-w-6xl mx-auto">
        <!-- Below lg: a labelled select replaces the section menu. -->
        <USelect
          v-model="currentPage"
          :items="selectItems"
          value-key="value"
          :icon="currentIcon"
          size="md"
          aria-label="Settings page"
          class="w-full lg:hidden"
        />
        <UNavigationMenu
          orientation="vertical"
          :items="menuItems"
          aria-label="Settings pages"
          class="hidden lg:flex lg:w-52 lg:shrink-0 lg:sticky lg:top-0"
          :ui="{ separator: 'hidden' }"
          data-shot="settings-nav"
          data-tour="settings-nav"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-4 sm:gap-6 lg:gap-12 lg:max-w-4xl">
          <NuxtPage />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
