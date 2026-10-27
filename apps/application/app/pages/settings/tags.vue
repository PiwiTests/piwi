<script setup lang="ts">
import { z } from 'zod';
import type { TableColumn } from '@nuxt/ui';
import type { TagInfo, TagsResponse } from '~~/types/api';

const { data: tagsData, refresh } = await useFetch<TagsResponse>('/api/tags');
const toast = useToast();
const { can } = useAuth();

const allTags = computed(() => tagsData.value?.items || []);

// Creating, editing and deleting tags is the `tags:manage` instance permission.
const canManageTags = computed(() => can('tags:manage'));

const DEFAULT_TAG_COLOR = '#6366f1';

const columns: TableColumn<TagInfo>[] = [
  { accessorKey: 'text', header: 'Tag' },
  { accessorKey: 'color', header: 'Color' },
  { accessorKey: 'createdAt', header: 'Created' },
  { id: 'actions', header: 'Actions' },
];

// Add tag modal
const isAddTagModalOpen = ref(false);
const addTagSchema = z.object({
  text: z.string().min(1, 'Tag text is required').max(50, 'Tag text must be at most 50 characters'),
  color: z.string().min(1, 'Color is required'),
});
type AddTagSchema = z.output<typeof addTagSchema>;

const newTag = reactive<Partial<AddTagSchema>>({
  text: '',
  color: DEFAULT_TAG_COLOR,
});

// Edit tag modal
const isEditTagModalOpen = ref(false);
const editingTag = ref<TagInfo | null>(null);
const editTagState = reactive<Partial<AddTagSchema>>({
  text: '',
  color: DEFAULT_TAG_COLOR,
});

function openEditTag(tag: TagInfo) {
  editingTag.value = tag;
  editTagState.text = tag.text;
  editTagState.color = tag.color;
  isEditTagModalOpen.value = true;
}

async function handleAddTag() {
  try {
    await $fetch('/api/tags', {
      method: 'POST',
      body: newTag,
    });

    toast.add({
      title: 'Tag created',
      description: `Tag "${newTag.text}" has been created successfully`,
      color: 'success',
    });

    isAddTagModalOpen.value = false;
    newTag.text = '';
    newTag.color = DEFAULT_TAG_COLOR;

    await refresh();
  } catch (error: unknown) {
    const errorMessage =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({
      title: 'Failed to create tag',
      description: errorMessage || 'An error occurred',
      color: 'error',
    });
  }
}

async function handleEditTag() {
  if (!editingTag.value) return;
  try {
    await $fetch(`/api/tags/${editingTag.value.id}`, {
      method: 'PATCH',
      body: {
        text: editTagState.text,
        color: editTagState.color,
      },
    });

    toast.add({
      title: 'Tag updated',
      description: `Tag has been updated successfully`,
      color: 'success',
    });

    isEditTagModalOpen.value = false;
    editingTag.value = null;

    await refresh();
  } catch (error: unknown) {
    const errorMessage =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({
      title: 'Failed to update tag',
      description: errorMessage || 'An error occurred',
      color: 'error',
    });
  }
}

// Delete confirmation
const isDeleteTagConfirmOpen = ref(false);
const tagToDelete = ref<TagInfo | null>(null);

function confirmDeleteTag(tag: TagInfo) {
  tagToDelete.value = tag;
  isDeleteTagConfirmOpen.value = true;
}

async function handleDeleteTag() {
  const tag = tagToDelete.value;
  if (!tag) return;
  isDeleteTagConfirmOpen.value = false;
  tagToDelete.value = null;

  try {
    await $fetch(`/api/tags/${tag.id}`, { method: 'DELETE' });

    toast.add({
      title: 'Tag deleted',
      description: `Tag "${tag.text}" has been deleted`,
      color: 'success',
    });

    await refresh();
  } catch (error: unknown) {
    const errorMessage =
      error && typeof error === 'object' && 'data' in error ? (error.data as { message?: string })?.message : undefined;
    toast.add({
      title: 'Failed to delete tag',
      description: errorMessage || 'An error occurred',
      color: 'error',
    });
  }
}
</script>

<template>
  <CapabilityDeclinedGuard capability="tags" label="Tags">
    <div class="space-y-6" data-tour="tags-page">
      <!-- Tags table -->
      <SectionCard
        v-if="allTags.length > 0"
        title="Tags"
        :count="allTags.length"
        help="settings.tags"
        data-tour="tags-list"
      >
        <template #actions>
          <UButton
            v-if="canManageTags"
            label="Add tag"
            icon="i-lucide-tag"
            size="sm"
            data-tour="add-tag"
            @click="isAddTagModalOpen = true"
          />
        </template>

        <UTable :data="allTags" :columns="columns">
          <template #text-cell="{ row }">
            <TagBadge :text="row.original.text" :color="row.original.color" />
          </template>

          <template #color-cell="{ row }">
            <div class="flex items-center gap-2">
              <span
                class="inline-block w-4 h-4 rounded-full border border-black/10"
                :style="{ backgroundColor: row.original.color }"
              />
              <span class="text-sm font-mono text-muted">{{ row.original.color }}</span>
            </div>
          </template>

          <template #createdAt-cell="{ row }">
            <ClientDate :date="row.original.createdAt" date-only class="text-sm text-muted" />
          </template>

          <template #actions-header>
            <span class="sr-only">Actions</span>
          </template>
          <template #actions-cell="{ row }">
            <div class="flex gap-1 justify-end">
              <UButton
                v-if="canManageTags"
                icon="i-lucide-pencil"
                color="neutral"
                variant="ghost"
                size="sm"
                @click="openEditTag(row.original)"
              />
              <UButton
                v-if="canManageTags"
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                size="sm"
                @click="confirmDeleteTag(row.original)"
              />
            </div>
          </template>
        </UTable>
      </SectionCard>

      <!-- Empty state -->
      <SectionCard v-else title="Tags" :count="0" help="settings.tags">
        <div class="text-center py-12">
          <div class="flex justify-center mb-4">
            <UIcon name="i-lucide-tags" class="text-4xl text-muted" />
          </div>
          <h3 class="text-lg font-semibold mb-2">No tags yet</h3>
          <p class="text-muted mb-4">Create tags to categorize and filter your projects</p>
          <UButton v-if="canManageTags" label="Add tag" icon="i-lucide-tag" @click="isAddTagModalOpen = true" />
        </div>
      </SectionCard>
    </div>

    <!-- Add Tag Modal -->
    <ClientOnly>
      <UModal :open="isAddTagModalOpen" title="Add new tag" @update:open="isAddTagModalOpen = $event">
        <template #body>
          <UForm :schema="addTagSchema" :state="newTag">
            <UFormField label="Tag text" name="text" required class="mb-4">
              <UInput v-model="newTag.text" placeholder="Enter tag name" />
            </UFormField>

            <UFormField label="Color" name="color" required class="mb-4">
              <div class="flex items-center gap-3">
                <input
                  v-model="newTag.color"
                  type="color"
                  class="w-10 h-10 rounded cursor-pointer border border-default"
                  aria-label="Pick tag color"
                />
                <UInput v-model="newTag.color" class="flex-1 font-mono" placeholder="#6366f1" />
              </div>
            </UFormField>

            <div v-if="newTag.text" class="mt-2">
              <span class="text-sm text-muted mr-2">Preview:</span>
              <TagBadge :text="newTag.text" :color="newTag.color || DEFAULT_TAG_COLOR" />
            </div>
          </UForm>
        </template>

        <template #footer>
          <UButton type="button" color="neutral" variant="ghost" label="Cancel" @click="isAddTagModalOpen = false" />
          <UButton type="submit" label="Create tag" icon="i-lucide-tag" @click="handleAddTag" />
        </template>
      </UModal>

      <!-- Edit Tag Modal -->
      <UModal :open="isEditTagModalOpen" title="Edit tag" @update:open="isEditTagModalOpen = $event">
        <template #body>
          <UForm :schema="addTagSchema" :state="editTagState">
            <UFormField label="Tag text" name="text" required class="mb-4">
              <UInput v-model="editTagState.text" placeholder="Enter tag name" />
            </UFormField>

            <UFormField label="Color" name="color" required class="mb-4">
              <div class="flex items-center gap-3">
                <input
                  v-model="editTagState.color"
                  type="color"
                  class="w-10 h-10 rounded cursor-pointer border border-default"
                  aria-label="Pick tag color"
                />
                <UInput v-model="editTagState.color" class="flex-1 font-mono" placeholder="#6366f1" />
              </div>
            </UFormField>

            <div v-if="editTagState.text" class="mt-2">
              <span class="text-sm text-muted mr-2">Preview:</span>
              <TagBadge :text="editTagState.text" :color="editTagState.color || DEFAULT_TAG_COLOR" />
            </div>
          </UForm>
        </template>

        <template #footer>
          <UButton type="button" color="neutral" variant="ghost" label="Cancel" @click="isEditTagModalOpen = false" />
          <UButton type="submit" label="Save changes" icon="i-lucide-check" @click="handleEditTag" />
        </template>
      </UModal>

      <!-- Delete Tag Confirmation Modal -->
      <UModal :open="isDeleteTagConfirmOpen" title="Delete tag" @update:open="isDeleteTagConfirmOpen = $event">
        <template #body>
          <p>
            Are you sure you want to delete tag
            <TagBadge v-if="tagToDelete" :text="tagToDelete.text" :color="tagToDelete.color" class="inline-flex" />? It
            will be removed from all projects.
          </p>
        </template>

        <template #footer>
          <UButton color="neutral" variant="ghost" label="Cancel" @click="isDeleteTagConfirmOpen = false" />
          <UButton color="error" label="Delete" icon="i-lucide-trash-2" @click="handleDeleteTag" />
        </template>
      </UModal>
    </ClientOnly>
  </CapabilityDeclinedGuard>
</template>
