<script setup lang="ts">
/**
 * The dashboard switcher in the analytics header: built-in, shared and
 * personal dashboards, with a search, and the shared dashboards nobody opened
 * for 90 days in an *Unused* group.
 */
import type { DashboardSummary } from '#shared/handlers/dashboards';
import { foldText } from '#shared/utils/fold-text';

const props = defineProps<{ current: { id: string; name: string }; items: DashboardSummary[] }>();

const open = ref(false);
const search = ref('');

const groups = computed(() => {
  const q = foldText(search.value.trim());
  const matches = props.items.filter(
    (d) => !q || foldText(d.name).includes(q) || foldText(d.description ?? '').includes(q),
  );
  return [
    { label: 'Built-in', items: matches.filter((d) => d.kind === 'builtin') },
    { label: 'Shared', items: matches.filter((d) => d.kind === 'saved' && d.visibility === 'shared' && !d.unused) },
    { label: 'Personal', items: matches.filter((d) => d.kind === 'saved' && d.visibility === 'private') },
    { label: 'Unused', items: matches.filter((d) => d.kind === 'saved' && d.unused) },
  ].filter((g) => g.items.length > 0);
});

function hrefOf(d: DashboardSummary): string {
  return `/analytics/d/${d.id}`;
}

watch(open, (isOpen) => {
  if (!isOpen) search.value = '';
});
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'start' }">
    <UButton
      color="neutral"
      variant="ghost"
      trailing-icon="i-lucide-chevrons-up-down"
      class="min-w-0 max-w-[14rem] sm:max-w-xs"
      :title="`Dashboard: ${current.name}`"
      data-testid="dashboard-switcher"
      data-tour="dashboard-switcher"
    >
      <span class="truncate">{{ current.name }}</span>
    </UButton>
    <template #content>
      <div class="w-72 max-w-[calc(100vw-2rem)] p-2 space-y-2" data-testid="dashboard-switcher-menu">
        <UInput
          v-model="search"
          icon="i-lucide-search"
          placeholder="Search dashboards"
          size="sm"
          class="w-full"
          aria-label="Search dashboards"
          autofocus
        />
        <div class="max-h-80 overflow-y-auto space-y-2">
          <p v-if="groups.length === 0" class="text-xs text-muted px-2 py-1">No dashboard matches.</p>
          <div v-for="group in groups" :key="group.label">
            <p class="text-xs font-medium text-muted px-2 py-1">{{ group.label }}</p>
            <ul>
              <li v-for="d in group.items" :key="d.id">
                <NuxtLink
                  :to="hrefOf(d)"
                  class="block rounded px-2 py-1.5 text-sm hover:bg-elevated"
                  :class="d.id === current.id ? 'bg-elevated text-highlighted' : 'text-default'"
                  :aria-current="d.id === current.id ? 'page' : undefined"
                  @click="open = false"
                >
                  <span class="block truncate">{{ d.name }}</span>
                  <span v-if="d.kind === 'saved' && d.ownerName && !d.mine" class="block text-xs text-muted truncate">
                    {{ d.ownerName }}
                  </span>
                </NuxtLink>
              </li>
            </ul>
          </div>
        </div>
        <div class="border-t border-default pt-2">
          <NuxtLink
            to="/analytics/dashboards"
            class="block rounded px-2 py-1.5 text-sm text-default hover:bg-elevated"
            @click="open = false"
          >
            Manage dashboards
          </NuxtLink>
        </div>
      </div>
    </template>
  </UPopover>
</template>
