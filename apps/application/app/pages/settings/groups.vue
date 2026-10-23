<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import {
  projectAccessUserName,
  sortProjectAccessUsers,
  type GroupListItem,
  type GroupsListResponse,
  type GroupView,
  type GroupWriteResponse,
  type UsersListResponse,
  type UserSummary,
} from '#shared/project-access';
import type { ApiResponse } from '~~/types/api';

const { data, error, refresh } = await useFetch<GroupsListResponse>('/api/groups');
const { data: usersData } = await useFetch<UsersListResponse>('/api/users');
const toast = useToast();
const config = useRuntimeConfig();
const { refreshDemoAccess } = useAuth();

const groups = computed(() => data.value?.groups ?? []);
const memberItems = computed(() => {
  const users: UserSummary[] = [...(usersData.value?.items ?? [])];
  return sortProjectAccessUsers(users).map((user) => ({
    label: projectAccessUserName(user),
    value: user.id,
  }));
});

function membersText(group: GroupListItem): string {
  return `${group.memberCount} ${group.memberCount === 1 ? 'member' : 'members'}`;
}

const columns: TableColumn<GroupListItem>[] = [
  { accessorKey: 'name', header: createSortHeader<GroupListItem>('Name'), meta: { class: { th: 'w-48', td: 'w-48' } } },
  { accessorKey: 'description', header: 'Description' },
  {
    accessorKey: 'memberCount',
    header: createSortHeader<GroupListItem>('Members'),
    meta: { class: { th: 'w-32', td: 'w-32' } },
  },
  { id: 'actions', header: 'Actions', meta: { class: { th: 'w-24', td: 'w-24' } } },
];

// ── Create and edit: one form for the name, description and members ────────
const isFormOpen = ref(false);
/** The group being edited; null while creating one. */
const editing = ref<GroupListItem | null>(null);
const form = reactive({ name: '', description: '', memberIds: [] as number[] });
const loadedMemberIds = ref<number[]>([]);
const formLoading = ref(false);
const formSaving = ref(false);
const formValid = computed(() => form.name.trim().length > 0);

function openCreate() {
  editing.value = null;
  Object.assign(form, { name: '', description: '', memberIds: [] });
  loadedMemberIds.value = [];
  isFormOpen.value = true;
}

async function openEdit(group: GroupListItem) {
  editing.value = group;
  Object.assign(form, { name: group.name, description: group.description ?? '', memberIds: [] });
  isFormOpen.value = true;
  formLoading.value = true;
  try {
    const view = await $fetch<GroupView>(`/api/groups/${group.id}`);
    loadedMemberIds.value = view.members.map((member) => member.id);
    form.memberIds = [...loadedMemberIds.value];
  } catch (err) {
    toast.add({ title: 'Couldn’t load the group', description: errorMessage(err), color: 'error' });
    isFormOpen.value = false;
  } finally {
    formLoading.value = false;
  }
}

const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((id) => b.includes(id));

async function saveForm() {
  if (!formValid.value) return;
  formSaving.value = true;
  const body = { name: form.name.trim(), description: form.description.trim() || null };
  try {
    let groupId: number;
    if (editing.value) {
      groupId = editing.value.id;
      if (body.name !== editing.value.name || body.description !== editing.value.description) {
        await $fetch<GroupWriteResponse>(`/api/groups/${groupId}`, { method: 'PATCH', body });
      }
    } else {
      groupId = (await $fetch<GroupWriteResponse>('/api/groups', { method: 'POST', body })).group.id;
    }
    if (!sameIds(form.memberIds, loadedMemberIds.value)) {
      await $fetch<GroupWriteResponse>(`/api/groups/${groupId}/members`, {
        method: 'PUT',
        body: { userIds: form.memberIds },
      });
    }
    toast.add({ title: editing.value ? 'Group saved' : 'Group created', description: body.name, color: 'success' });
    void refreshDemoAccess();
    isFormOpen.value = false;
  } catch (err) {
    toast.add({
      title: editing.value ? 'Failed to save the group' : 'Failed to create the group',
      description: errorMessage(err, 'An error occurred'),
      color: 'error',
    });
  } finally {
    formSaving.value = false;
    await refresh();
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────
const groupToDelete = ref<GroupListItem | null>(null);
const isDeleteOpen = ref(false);

function askDelete(group: GroupListItem) {
  groupToDelete.value = group;
  isDeleteOpen.value = true;
}

async function confirmDelete() {
  const group = groupToDelete.value;
  isDeleteOpen.value = false;
  if (!group) return;
  try {
    await $fetch<ApiResponse<typeof import('~~/server/api/groups/[id].delete').default>>(`/api/groups/${group.id}`, {
      method: 'DELETE',
    });
    toast.add({ title: 'Group deleted', description: group.name, color: 'success' });
    void refreshDemoAccess();
  } catch (err) {
    toast.add({ title: 'Failed to delete the group', description: errorMessage(err), color: 'error' });
  }
  await refresh();
}
</script>

<template>
  <div class="space-y-6" data-tour="groups-page">
    <UAlert
      v-if="!config.public.authEnabled"
      icon="i-lucide-info"
      color="neutral"
      variant="subtle"
      title="Authentication is disabled"
      description="Groups and their roles apply once authentication is enabled with PIWI_AUTH_ENABLED. Until then every visitor can do everything on every project."
    />

    <SectionCard
      title="Groups"
      :count="groups.length"
      help="settings.groups"
      data-shot="groups-table"
      data-tour="groups-list"
    >
      <template v-if="groups.length > 0" #actions>
        <UButton label="Add group" icon="i-lucide-plus" size="sm" data-tour="add-group" @click="openCreate" />
      </template>

      <ErrorState v-if="error" :text="`Couldn't load the groups: ${errorMessage(error)}`">
        <template #action>
          <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
            Retry
          </UButton>
        </template>
      </ErrorState>

      <EmptyState
        v-else-if="groups.length === 0"
        icon="i-lucide-users-round"
        text="No groups yet. Create one, add its members, then give it roles on the permission grid."
      >
        <UButton label="Add group" icon="i-lucide-plus" size="sm" @click="openCreate" />
      </EmptyState>

      <template v-else>
        <!-- Phone: one card per group. -->
        <ul class="space-y-2 md:hidden">
          <li
            v-for="group in groups"
            :key="group.id"
            class="flex items-start justify-between gap-2 rounded-lg border border-default p-3"
          >
            <div class="min-w-0">
              <p class="text-sm font-semibold text-highlighted break-words">{{ group.name }}</p>
              <p v-if="group.description" class="text-sm text-highlighted break-words">{{ group.description }}</p>
              <p class="text-xs text-muted">{{ membersText(group) }}</p>
            </div>
            <GroupRowActions :name="group.name" class="shrink-0" @edit="openEdit(group)" @delete="askDelete(group)" />
          </li>
        </ul>

        <div class="hidden md:block">
          <UTable
            :data="groups"
            :columns="columns"
            sticky
            class="max-h-[32rem]"
            :ui="{ base: 'lg:table-fixed lg:w-full' }"
          >
            <template #name-cell="{ row }">
              <span class="block truncate text-highlighted" :title="row.original.name">{{ row.original.name }}</span>
            </template>
            <template #description-cell="{ row }">
              <span v-if="row.original.description" class="block truncate text-sm" :title="row.original.description">{{
                row.original.description
              }}</span>
              <span v-else class="text-muted">—</span>
            </template>
            <template #memberCount-cell="{ row }">
              <span class="text-sm text-muted">{{ membersText(row.original) }}</span>
            </template>
            <template #actions-header>
              <span class="sr-only">Actions</span>
            </template>
            <template #actions-cell="{ row }">
              <GroupRowActions
                :name="row.original.name"
                @edit="openEdit(row.original)"
                @delete="askDelete(row.original)"
              />
            </template>
          </UTable>
        </div>

        <p class="mt-3 text-xs text-muted">
          A group’s roles are set on the
          <NuxtLink
            to="/settings/permissions"
            class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >permission grid</NuxtLink
          >
          or in a project’s members; its members hold them on top of their own.
        </p>
      </template>
    </SectionCard>
  </div>

  <!-- Create or edit a group -->
  <ClientOnly>
    <UModal
      :open="isFormOpen"
      :title="editing ? `Edit group – ${editing.name}` : 'Add group'"
      @update:open="isFormOpen = $event"
    >
      <template #body>
        <LoadingState v-if="formLoading" text="Loading the group…" />
        <form v-else class="space-y-5" data-shot="group-form" @submit.prevent="saveForm">
          <UFormField label="Name" name="name" required>
            <UInput v-model="form.name" placeholder="QA, Product owners, CI…" class="w-full" />
          </UFormField>
          <UFormField label="Description" name="description">
            <UInput v-model="form.description" placeholder="What the group is for (optional)" class="w-full" />
          </UFormField>
          <UFormField label="Members" name="members" description="They hold every role the group is given">
            <USelectMenu
              v-model="form.memberIds"
              :items="memberItems"
              value-key="value"
              multiple
              placeholder="No members"
              :search-input="{ placeholder: 'Filter users…' }"
              class="w-full"
            />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="isFormOpen = false" />
          <UButton
            :label="editing ? 'Save group' : 'Create group'"
            icon="i-lucide-check"
            :loading="formSaving"
            :disabled="!formValid || formLoading"
            @click="saveForm"
          />
        </div>
      </template>
    </UModal>
  </ClientOnly>

  <!-- Delete confirmation -->
  <ClientOnly>
    <UModal :open="isDeleteOpen" title="Delete group" @update:open="isDeleteOpen = $event">
      <template #body>
        <p class="text-sm text-highlighted leading-relaxed">
          Delete the group <strong>{{ groupToDelete?.name }}</strong
          >? Its members stay, but lose the roles they held through it. This cannot be undone.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="isDeleteOpen = false" />
          <UButton color="error" label="Delete group" icon="i-lucide-trash-2" @click="confirmDelete" />
        </div>
      </template>
    </UModal>
  </ClientOnly>
</template>
