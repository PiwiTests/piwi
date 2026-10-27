<script setup lang="ts">
import type { MarkerInfo } from '~~/types/api';
import { getMarkerCategory } from '#shared/marker-categories';

/**
 * Body of the markers panel: the project's timeline markers as a vertical
 * list, newest first, and the add / edit form, shown in place of the list.
 */
const props = defineProps<{
  projectId: number;
  markers: MarkerInfo[];
  environments: string[];
  /** When set, open this marker (e.g. after clicking a chart line). */
  focusMarkerId?: number | null;
}>();

const emit = defineEmits<{ changed: []; 'clear-focus': [] }>();

const toast = useToast();
// Adding, editing and removing markers needs `marker:write` on the project.
const { can } = useAuth();
const canEdit = computed(() => can('marker:write', props.projectId));

const rows = computed(() => [...props.markers].sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt)));

// The panel shows either the list or the form; `editing` null in the form means "add".
const view = ref<'list' | 'form'>('list');
const editing = ref<MarkerInfo | null>(null);
// The marker last opened or saved, outlined in the list so it is easy to find again.
const highlightId = ref<number | null>(null);

function openAdd() {
  editing.value = null;
  view.value = 'form';
}

function openEdit(marker: MarkerInfo) {
  editing.value = marker;
  highlightId.value = marker.id;
  view.value = 'form';
}

async function backToList() {
  view.value = 'list';
  editing.value = null;
  await nextTick();
  if (highlightId.value != null) {
    document.getElementById(`marker-${highlightId.value}`)?.scrollIntoView({ block: 'nearest' });
  }
}

function onSaved(id: number) {
  highlightId.value = id;
  emit('changed');
  backToList();
}

// A click on a chart line opens that marker: in the form for an editor, or
// outlined in the list for a reader.
watch(
  () => props.focusMarkerId,
  (id) => {
    if (id == null) return;
    const target = props.markers.find((m) => m.id === id);
    if (target && canEdit.value) openEdit(target);
    else if (target) {
      highlightId.value = target.id;
      backToList();
    }
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
    if (editing.value?.id === marker.id) backToList();
  } catch (error: unknown) {
    toast.add({ title: 'Failed to delete marker', description: errorMessage(error), color: 'error' });
  }
}
</script>

<template>
  <div data-shot="markers-panel" data-tour="project-timeline">
    <div v-if="view === 'form'" class="space-y-4">
      <div class="flex items-center gap-2">
        <UButton
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Back to the markers"
          @click="backToList"
        />
        <h3 class="font-semibold text-highlighted">{{ editing ? 'Edit marker' : 'Add marker' }}</h3>
      </div>
      <MarkerForm
        :key="editing?.id ?? 'new'"
        :project-id="projectId"
        :marker="editing"
        :environments="environments"
        @saved="onSaved"
        @cancel="backToList"
        @delete="confirmDelete"
      />
    </div>

    <div v-else class="space-y-4">
      <div class="flex items-center justify-between gap-3">
        <p class="flex items-center gap-1.5 text-sm text-muted">
          {{ markers.length }} {{ markers.length === 1 ? 'marker' : 'markers' }}, newest first
          <HelpHint topic="project.timeline" />
        </p>
        <UButton v-if="canEdit" label="Add marker" icon="i-lucide-plus" size="sm" @click="openAdd" />
      </div>

      <EmptyState
        v-if="markers.length === 0"
        icon="i-lucide-milestone"
        text="No markers yet. Add a deploy, config change, or incident to see it on the charts."
      />

      <ol v-else data-testid="marker-list">
        <li
          v-for="(m, index) in rows"
          :id="`marker-${m.id}`"
          :key="m.id"
          class="flex gap-3 scroll-mt-4"
          :data-testid="`marker-item-${m.id}`"
        >
          <!-- Category icon on a vertical line joining the markers. -->
          <div class="flex flex-col items-center">
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-full ring"
              :class="MARKER_TONE_CLASSES[getMarkerCategory(m.category).color].soft"
            >
              <UIcon :name="getMarkerCategory(m.category).icon" class="size-4" />
            </span>
            <span v-if="index < rows.length - 1" class="w-px flex-1 bg-accented my-1" />
          </div>

          <div
            class="min-w-0 flex-1 rounded-lg border p-3 mb-3 transition-colors"
            :class="highlightId === m.id ? 'border-primary bg-primary/5' : 'border-default'"
          >
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-highlighted break-words">{{ m.label }}</div>
                <div class="mt-0.5 text-xs text-muted">
                  <ClientDate :date="m.occurredAt" />
                  <ClientOnly> · {{ formatRelativeTime(m.occurredAt) }}</ClientOnly>
                </div>
              </div>
              <div v-if="canEdit" class="flex shrink-0 -me-1 -mt-1">
                <UButton
                  icon="i-lucide-pencil"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :aria-label="`Edit ${m.label}`"
                  @click="openEdit(m)"
                />
                <UButton
                  icon="i-lucide-trash-2"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :aria-label="`Delete ${m.label}`"
                  @click="confirmDelete(m)"
                />
              </div>
            </div>

            <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <MarkerBadge :marker="m" category-only size="sm" />
              <EnvironmentBadge v-if="m.environment" :name="m.environment" />
              <span v-else class="text-muted">All environments</span>
              <NuxtLink v-if="m.runId" :to="`/test-runs/${m.runId}`" class="text-primary hover:underline">
                Run #{{ m.runId }}
              </NuxtLink>
            </div>

            <p v-if="m.description" class="mt-2 text-sm text-muted whitespace-pre-line break-words">
              {{ m.description }}
            </p>
          </div>
        </li>
      </ol>
    </div>

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
  </div>
</template>
