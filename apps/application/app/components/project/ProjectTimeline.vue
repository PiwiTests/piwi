<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { MarkerInfo } from '~~/types/api';
import { getMarkerCategory } from '#shared/marker-categories';

const props = defineProps<{
  projectId: number;
  markers: MarkerInfo[];
  environments: string[];
  /** When set, open this marker in the editor (e.g. after clicking a chart line). */
  focusMarkerId?: number | null;
}>();

const emit = defineEmits<{ changed: []; 'clear-focus': [] }>();

const toast = useToast();
// Adding, editing and removing markers needs `marker:write` on the project.
const { can } = useAuth();
const canEdit = computed(() => can('marker:write', props.projectId));

// Newest first for the management table.
const rows = computed(() => [...props.markers].sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt)));

const columns: TableColumn<MarkerInfo>[] = [
  { accessorKey: 'occurredAt', header: 'When' },
  { accessorKey: 'category', header: 'Category' },
  { accessorKey: 'label', header: 'Label' },
  { accessorKey: 'environment', header: 'Environment' },
  { id: 'actions', header: 'Actions' },
];

const isFormOpen = ref(false);
const editing = ref<MarkerInfo | null>(null);

function openAdd() {
  editing.value = null;
  isFormOpen.value = true;
}

function openEdit(marker: MarkerInfo) {
  editing.value = marker;
  isFormOpen.value = true;
}

// Open the editor when a chart line is clicked (focusMarkerId set by the page).
watch(
  () => props.focusMarkerId,
  (id) => {
    if (id == null) return;
    const target = props.markers.find((m) => m.id === id);
    if (target) openEdit(target);
    emit('clear-focus');
  },
  { immediate: true },
);

const isDeleteOpen = ref(false);
const toDelete = ref<MarkerInfo | null>(null);

function confirmDelete(marker: MarkerInfo) {
  toDelete.value = marker;
  isDeleteOpen.value = true;
}

async function handleDelete() {
  const marker = toDelete.value;
  isDeleteOpen.value = false;
  toDelete.value = null;
  if (!marker) return;
  try {
    await $fetch(`/api/markers/${marker.id}`, { method: 'DELETE' });
    toast.add({ title: 'Marker deleted', color: 'success' });
    emit('changed');
  } catch (error: unknown) {
    toast.add({ title: 'Failed to delete marker', description: errorMessage(error), color: 'error' });
  }
}
</script>

<template>
  <SectionCard
    title="Timeline markers"
    :count="markers.length"
    icon="i-lucide-milestone"
    help="project.timeline"
    data-tour="project-timeline"
    subtitle="Dated events overlaid on the analytics charts"
  >
    <template #actions>
      <UButton v-if="canEdit" label="Add marker" icon="i-lucide-plus" size="sm" @click="openAdd" />
    </template>

    <EmptyState
      v-if="markers.length === 0"
      icon="i-lucide-milestone"
      text="No markers yet. Add a deploy, config change, or incident to see it on the charts."
    />

    <template v-else>
      <!-- Mobile card list -->
      <div class="md:hidden space-y-3">
        <div v-for="m in rows" :key="m.id" class="rounded-lg border border-default p-3 space-y-2">
          <div class="flex items-start justify-between gap-2">
            <MarkerBadge :marker="m" />
            <div v-if="canEdit" class="flex gap-1 shrink-0">
              <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="xs" @click="openEdit(m)" />
              <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="xs" @click="confirmDelete(m)" />
            </div>
          </div>
          <div class="text-sm text-muted"><ClientDate :date="m.occurredAt" /></div>
          <div v-if="m.environment" class="text-xs">
            <EnvironmentBadge :name="m.environment" />
          </div>
          <p v-if="m.description" class="text-sm text-muted">{{ m.description }}</p>
        </div>
      </div>

      <!-- Desktop table -->
      <UTable :data="rows" :columns="columns" class="hidden md:block">
        <template #occurredAt-cell="{ row }">
          <div class="whitespace-nowrap">
            <ClientDate :date="row.original.occurredAt" class="text-sm" />
            <div class="text-xs text-muted">
              <ClientOnly>{{ formatRelativeTime(row.original.occurredAt) }}</ClientOnly>
            </div>
          </div>
        </template>

        <template #category-cell="{ row }">
          <UBadge :color="getMarkerCategory(row.original.category).color" variant="subtle" size="sm" class="gap-1">
            <UIcon :name="getMarkerCategory(row.original.category).icon" class="size-3" />
            {{ getMarkerCategory(row.original.category).label }}
          </UBadge>
        </template>

        <template #label-cell="{ row }">
          <div>
            <div class="font-medium flex items-center gap-1">
              {{ row.original.label }}
              <UIcon
                v-if="row.original.source === 'auto'"
                name="i-lucide-sparkles"
                class="size-3 text-muted"
                title="Automatically detected"
              />
            </div>
            <div v-if="row.original.description" class="text-xs text-muted line-clamp-1">
              {{ row.original.description }}
            </div>
          </div>
        </template>

        <template #environment-cell="{ row }">
          <EnvironmentBadge v-if="row.original.environment" :name="row.original.environment" class="text-xs" />
          <span v-else class="text-xs text-muted">All</span>
        </template>

        <template #actions-header>
          <span class="sr-only">Actions</span>
        </template>
        <template #actions-cell="{ row }">
          <div v-if="canEdit" class="flex gap-1 justify-end">
            <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" @click="openEdit(row.original)" />
            <UButton
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="sm"
              @click="confirmDelete(row.original)"
            />
          </div>
        </template>
      </UTable>
    </template>

    <MarkerFormModal
      v-model:open="isFormOpen"
      :project-id="projectId"
      :marker="editing"
      :environments="environments"
      @saved="emit('changed')"
    />

    <ClientOnly>
      <UModal :open="isDeleteOpen" title="Delete marker" @update:open="isDeleteOpen = $event">
        <template #body>
          <p>
            Delete marker
            <MarkerBadge v-if="toDelete" :marker="toDelete" class="inline-flex align-middle" />? This can't be undone.
          </p>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" label="Cancel" @click="isDeleteOpen = false" />
          <UButton color="error" label="Delete" icon="i-lucide-trash-2" @click="handleDelete" />
        </template>
      </UModal>
    </ClientOnly>
  </SectionCard>
</template>
