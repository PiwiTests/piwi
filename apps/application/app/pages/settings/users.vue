<script setup lang="ts">
import { z } from 'zod';
import type { TableColumn } from '@nuxt/ui';
import { INSTANCE_ROLE_LABELS, InstanceRole, ProjectRole } from '#shared/permissions';
import type {
  GroupsListResponse,
  UserListItem,
  UserProjectRolesResponse,
  UsersListResponse,
  UserSummary,
  UserWriteResponse,
} from '#shared/project-access';
import type { ApiResponse, ProjectMenuItem } from '~~/types/api';

const { data: usersData, refresh } = await useFetch<UsersListResponse>('/api/users');
const { data: groupsData, refresh: refreshGroups } = await useFetch<GroupsListResponse>('/api/groups');
const toast = useToast();
const { authState, can, refreshDemoAccess } = useAuth();

/** An administrator gets the full rows; anyone else reaching this page would get summaries. */
const isListItem = (user: UserListItem | UserSummary): user is UserListItem => 'instanceRole' in user;
const users = computed(() => (usersData.value?.items ?? []).filter(isListItem));
const groups = computed(() => groupsData.value?.groups ?? []);
const groupNames = computed(() => new Map(groups.value.map((group) => [group.id, group.name])));
const authEnabled = computed(() => usersData.value?.authEnabled || false);

// Everyone is an administrator when authentication is off.
const isAdmin = computed(() => can('users:manage'));
const currentUserId = computed(() => authState.value.user?.id ?? null);

const roleOptions = [InstanceRole.MEMBER, InstanceRole.ADMINISTRATOR].map((role) => ({
  label: INSTANCE_ROLE_LABELS[role],
  value: role,
}));

function displayName(user: Pick<UserListItem, 'name' | 'username'>): string {
  return user.name || user.username;
}

function groupsText(user: UserListItem): string {
  return user.groupIds
    .map((id) => groupNames.value.get(id))
    .filter(Boolean)
    .join(', ');
}

/** Replace one user's row in the fetched list, so an edit shows before the list reloads. */
function patchUserRow(userId: number, patch: Partial<UserListItem>) {
  if (!usersData.value) return;
  usersData.value = {
    ...usersData.value,
    items: users.value.map((user) => (user.id === userId ? { ...user, ...patch } : user)),
  };
}

// The table uses a fixed layout from `lg` up (see the `lg:table-fixed` UI class
// below) so it fits the settings card beside the settings menu instead of
// overflowing into a horizontal scrollbar: the role, groups, created and actions
// columns get fixed widths and the user column takes the rest, its handle and
// email on the line under the name (as on the phone cards). Below `md` a card
// list replaces it.
/** The line under a user's name: their handle (when the name is shown above it) and email. */
function handleLine(user: UserListItem): string {
  return [user.name ? `@${user.username}` : '', user.email ?? ''].filter(Boolean).join(' · ');
}

const columns: TableColumn<UserListItem>[] = [
  { accessorKey: 'username', header: createSortHeader<UserListItem>('User') },
  {
    accessorKey: 'instanceRole',
    header: createSortHeader<UserListItem>('Role'),
    meta: { class: { th: 'w-36', td: 'w-36' } },
  },
  { id: 'groups', header: 'Groups', meta: { class: { th: 'w-40', td: 'w-40' } } },
  {
    accessorKey: 'createdAt',
    header: createSortHeader<UserListItem>('Created'),
    meta: { class: { th: 'w-24', td: 'w-24' } },
  },
  { id: 'actions', header: 'Actions', meta: { class: { th: 'w-36', td: 'w-36' } } },
];

// ── Add user ────────────────────────────────────────────────────────────────
const isAddUserModalOpen = ref(false);
const addUserSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z
    .union([z.string().min(8, 'Password must be at least 8 characters'), z.literal('').transform(() => undefined)])
    .optional(),
  role: z.enum(InstanceRole),
  name: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  groupIds: z.array(z.number()).optional(),
});

type AddUserSchema = z.output<typeof addUserSchema>;

function emptyNewUser(): Partial<AddUserSchema> {
  return { username: '', password: '', role: InstanceRole.MEMBER, name: '', email: '', groupIds: [] };
}

const newUser = reactive<Partial<AddUserSchema>>(emptyNewUser());

async function handleAddUser() {
  try {
    const body = { ...newUser, password: newUser.password || undefined };
    await $fetch<UserWriteResponse>('/api/users', { method: 'POST', body });

    toast.add({
      title: 'User created',
      description: `User ${newUser.username} has been created successfully`,
      color: 'success',
    });

    isAddUserModalOpen.value = false;
    Object.assign(newUser, emptyNewUser());
    await Promise.all([refresh(), refreshGroups()]);
  } catch (error: unknown) {
    toast.add({
      title: 'Failed to create user',
      description: errorMessage(error, 'An error occurred'),
      color: 'error',
    });
  }
}

// ── Delete user ─────────────────────────────────────────────────────────────
const isDeleteUserConfirmOpen = ref(false);
const userToDelete = ref<UserListItem | null>(null);

function handleDeleteUser(user: UserListItem) {
  userToDelete.value = user;
  isDeleteUserConfirmOpen.value = true;
}

async function confirmDeleteUser() {
  const user = userToDelete.value;
  if (!user) return;
  isDeleteUserConfirmOpen.value = false;
  userToDelete.value = null;

  try {
    await $fetch<ApiResponse<typeof import('~~/server/api/users/[id].delete').default>>(`/api/users/${user.id}`, {
      method: 'DELETE',
    });
    toast.add({ title: 'User deleted', description: `User ${user.username} has been deleted`, color: 'success' });
    await Promise.all([refresh(), refreshGroups()]);
  } catch (error: unknown) {
    toast.add({
      title: 'Failed to delete user',
      description: errorMessage(error, 'An error occurred'),
      color: 'error',
    });
  }
}

// ── Instance role and groups, saved at once ─────────────────────────────────
// Available to administrators for every user, including accounts provisioned
// through OAuth, which sign up as members with no project role.
async function handleChangeRole(user: UserListItem, role: InstanceRole) {
  if (role === user.instanceRole) return;
  patchUserRow(user.id, { instanceRole: role });
  try {
    await $fetch<UserWriteResponse>(`/api/users/${user.id}`, { method: 'PATCH', body: { role } });
    toast.add({
      title: 'Role updated',
      description: `${user.username} is now ${INSTANCE_ROLE_LABELS[role]}`,
      color: 'success',
    });
    void refreshDemoAccess();
  } catch (error: unknown) {
    // The server keeps the last administrator: its message says so.
    toast.add({
      title: 'Failed to update role',
      description: errorMessage(error, 'An error occurred'),
      color: 'error',
    });
  }
  await refresh();
}

async function handleChangeGroups(user: UserListItem, groupIds: number[]) {
  patchUserRow(user.id, { groupIds });
  try {
    await $fetch<UserWriteResponse>(`/api/users/${user.id}`, { method: 'PATCH', body: { groupIds } });
    toast.add({ title: 'Groups updated', description: `Groups of ${user.username} saved`, color: 'success' });
    void refreshDemoAccess();
  } catch (error: unknown) {
    toast.add({
      title: 'Failed to update groups',
      description: errorMessage(error, 'An error occurred'),
      color: 'error',
    });
  }
  await Promise.all([refresh(), refreshGroups()]);
}

// ── API keys: the list, create form and revoke flow live in <ApiKeysManager> ─
const selectedUserForKeys = ref<UserListItem | null>(null);
const isApiKeysModalOpen = ref(false);

function openApiKeysModal(user: UserListItem) {
  selectedUserForKeys.value = user;
  isApiKeysModalOpen.value = true;
}

function canManageApiKeys(user: UserListItem): boolean {
  return isAdmin.value || currentUserId.value === user.id;
}

// ── Project roles of one user ───────────────────────────────────────────────
const rolesUser = ref<UserListItem | null>(null);
const isRolesModalOpen = ref(false);
const rolesLoading = ref(false);
const rolesSaving = ref(false);
const allProjectsChoice = ref<ProjectRoleChoice>(NO_PROJECT_ROLE);
const projectRoles = ref<{ projectId: number; role: ProjectRole }[]>([]);
const inheritedGroups = ref<{ id: number; name: string }[]>([]);
const projectsList = ref<ProjectMenuItem[]>([]);

/** The role a project gets when it is added to the list. */
const NEW_PROJECT_ROLE = ProjectRole.VIEWER;
const allProjectsItems = projectRoleSelectItems(undefined, { none: true });
const roleItems = projectRoleSelectItems();

const projectName = (projectId: number) => {
  const project = projectsList.value.find((p) => p.id === projectId);
  return project ? project.label || project.name : `Project #${projectId}`;
};
const projectsToAdd = computed(() =>
  projectsList.value
    .filter((project) => !projectRoles.value.some((entry) => entry.projectId === project.id))
    .map((project) => ({ label: project.label || project.name, value: project.id })),
);

async function openRolesModal(user: UserListItem) {
  rolesUser.value = user;
  isRolesModalOpen.value = true;
  rolesLoading.value = true;
  try {
    const [menu, roles] = await Promise.all([
      $fetch<{ items: ProjectMenuItem[] }>('/api/projects/menu'),
      $fetch<UserProjectRolesResponse>(`/api/users/${user.id}/projects`),
    ]);
    projectsList.value = menu.items;
    allProjectsChoice.value = roles.allProjects ?? NO_PROJECT_ROLE;
    projectRoles.value = roles.projects.map((entry) => ({ ...entry }));
    inheritedGroups.value = roles.groups;
  } catch (error: unknown) {
    toast.add({ title: 'Couldn’t load project roles', description: errorMessage(error), color: 'error' });
    isRolesModalOpen.value = false;
  } finally {
    rolesLoading.value = false;
  }
}

function addProjectRole(projectId: unknown) {
  if (typeof projectId !== 'number') return;
  projectRoles.value = [...projectRoles.value, { projectId, role: NEW_PROJECT_ROLE }];
}

function removeProjectRole(projectId: number) {
  projectRoles.value = projectRoles.value.filter((entry) => entry.projectId !== projectId);
}

async function handleSaveProjectRoles() {
  const user = rolesUser.value;
  if (!user) return;
  rolesSaving.value = true;
  try {
    await $fetch<UserProjectRolesResponse>(`/api/users/${user.id}/projects`, {
      method: 'PUT',
      body: { allProjects: projectRoleFromChoice(allProjectsChoice.value), projects: projectRoles.value },
    });
    toast.add({ title: 'Project roles updated', description: `Roles of ${user.username} saved`, color: 'success' });
    void refreshDemoAccess();
    isRolesModalOpen.value = false;
  } catch (error: unknown) {
    toast.add({
      title: 'Failed to update project roles',
      description: errorMessage(error, 'An error occurred'),
      color: 'error',
    });
  } finally {
    rolesSaving.value = false;
  }
}

// ── Invite ──────────────────────────────────────────────────────────────────
const invitingUserId = ref<number | null>(null);

async function handleInviteUser(user: UserListItem) {
  if (!user.email) {
    toast.add({ title: 'No email address', description: 'Set an email address for this user first.', color: 'error' });
    return;
  }
  invitingUserId.value = user.id;
  try {
    await $fetch<ApiResponse<typeof import('~~/server/api/users/[id]/invite.post').default>>(
      `/api/users/${user.id}/invite`,
      { method: 'POST' },
    );
    toast.add({ title: 'Invite sent', description: `Invitation sent to ${user.email}`, color: 'success' });
  } catch (e) {
    toast.add({ title: 'Failed to send invite', description: errorMessage(e, 'An error occurred'), color: 'error' });
  } finally {
    invitingUserId.value = null;
  }
}
</script>

<template>
  <div class="space-y-6" data-tour="users-page">
    <UAlert
      v-if="!authEnabled"
      icon="i-lucide-info"
      color="primary"
      variant="subtle"
      title="Authentication is disabled"
      description="Authentication is currently disabled. You can manage users here, but they will only be used when authentication is enabled via the PIWI_AUTH_ENABLED environment variable."
    />

    <SectionCard
      v-if="users.length > 0"
      title="Users"
      :count="users.length"
      help="settings.users"
      data-shot="users-table"
      data-tour="users-list"
    >
      <template #actions>
        <UButton
          v-if="isAdmin"
          label="Add user"
          icon="i-lucide-user-plus"
          size="sm"
          data-tour="add-user"
          @click="isAddUserModalOpen = true"
        />
      </template>

      <!-- Phone: one card per user, the same controls stacked. -->
      <ul class="space-y-2 md:hidden">
        <li v-for="user in users" :key="user.id" class="rounded-lg border border-default p-3 space-y-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-semibold text-highlighted break-words">{{ displayName(user) }}</p>
              <p class="text-xs text-muted break-words">
                @{{ user.username }}<template v-if="user.email"> · {{ user.email }}</template>
              </p>
            </div>
            <UserRowActions
              :user="user"
              :can-manage="isAdmin"
              :can-manage-keys="canManageApiKeys(user)"
              :inviting="invitingUserId === user.id"
              class="shrink-0"
              @invite="handleInviteUser(user)"
              @project-roles="openRolesModal(user)"
              @api-keys="openApiKeysModal(user)"
              @delete="handleDeleteUser(user)"
            />
          </div>
          <div v-if="isAdmin" class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <USelect
              :model-value="user.instanceRole"
              :items="roleOptions"
              size="sm"
              class="w-full"
              :aria-label="`Change role for ${user.username}`"
              @update:model-value="(value) => handleChangeRole(user, value as InstanceRole)"
            />
            <UserGroupsSelect
              :model-value="user.groupIds"
              :groups="groups"
              deferred
              size="sm"
              :aria-label="`Groups of ${user.username}`"
              @update:model-value="(ids) => handleChangeGroups(user, ids)"
            />
          </div>
          <p v-else class="text-xs text-muted">
            {{ INSTANCE_ROLE_LABELS[user.instanceRole]
            }}<template v-if="groupsText(user)"> · {{ groupsText(user) }}</template>
          </p>
        </li>
      </ul>

      <div class="hidden md:block">
        <UTable
          :data="users"
          :columns="columns"
          sticky
          class="max-h-[32rem]"
          :ui="{ base: 'lg:table-fixed lg:w-full' }"
        >
          <template #username-cell="{ row }">
            <span class="block truncate text-highlighted" :title="displayName(row.original)">{{
              displayName(row.original)
            }}</span>
            <span class="flex items-center gap-1 min-w-0 text-xs text-muted">
              <span class="truncate" :title="handleLine(row.original)">{{ handleLine(row.original) }}</span>
              <UIcon
                v-if="row.original.email && row.original.emailVerified"
                name="i-lucide-circle-check-big"
                class="size-3.5 shrink-0 text-success-500"
                title="Email verified"
              />
            </span>
          </template>

          <template #instanceRole-cell="{ row }">
            <USelect
              v-if="isAdmin"
              :model-value="row.original.instanceRole"
              :items="roleOptions"
              size="sm"
              class="w-full"
              :aria-label="`Change role for ${row.original.username}`"
              @update:model-value="(value) => handleChangeRole(row.original, value as InstanceRole)"
            />
            <span v-else class="text-sm">{{ INSTANCE_ROLE_LABELS[row.original.instanceRole] }}</span>
          </template>

          <template #groups-cell="{ row }">
            <UserGroupsSelect
              v-if="isAdmin"
              :model-value="row.original.groupIds"
              :groups="groups"
              deferred
              size="sm"
              :aria-label="`Groups of ${row.original.username}`"
              @update:model-value="(ids) => handleChangeGroups(row.original, ids)"
            />
            <span v-else class="block truncate text-sm text-muted" :title="groupsText(row.original)">{{
              groupsText(row.original) || '—'
            }}</span>
          </template>

          <template #createdAt-cell="{ row }">
            <ClientDate :date="row.original.createdAt" date-only class="text-sm text-muted" />
          </template>

          <template #actions-header>
            <span class="sr-only">Actions</span>
          </template>
          <template #actions-cell="{ row }">
            <UserRowActions
              :user="row.original"
              :can-manage="isAdmin"
              data-tour="user-row-actions"
              :can-manage-keys="canManageApiKeys(row.original)"
              :inviting="invitingUserId === row.original.id"
              @invite="handleInviteUser(row.original)"
              @project-roles="openRolesModal(row.original)"
              @api-keys="openApiKeysModal(row.original)"
              @delete="handleDeleteUser(row.original)"
            />
          </template>
        </UTable>
      </div>
    </SectionCard>

    <!-- Empty state -->
    <SectionCard v-else title="Users" :count="0" help="settings.users">
      <EmptyState icon="i-lucide-users" text="No users yet. Create the first one to start using authentication.">
        <UButton v-if="isAdmin" label="Add user" icon="i-lucide-user-plus" @click="isAddUserModalOpen = true" />
      </EmptyState>
    </SectionCard>
  </div>

  <!-- Add user -->
  <ClientOnly>
    <UModal :open="isAddUserModalOpen" title="Add new user" @update:open="isAddUserModalOpen = $event">
      <template #body>
        <UForm :schema="addUserSchema" :state="newUser" class="space-y-5">
          <UFormField label="Username" name="username" required>
            <UInput v-model="newUser.username" placeholder="Enter username" class="w-full" />
          </UFormField>

          <UFormField
            label="Password"
            name="password"
            description="Leave blank to let the user set their own password via invite email"
          >
            <UInput
              v-model="newUser.password"
              type="password"
              placeholder="Leave blank to send invite"
              class="w-full"
            />
          </UFormField>

          <UFormField label="Display name" name="name">
            <UInput v-model="newUser.name" placeholder="Enter display name (optional)" class="w-full" />
          </UFormField>

          <UFormField label="Email" name="email" description="Optional — needed for invites and notifications">
            <UInput v-model="newUser.email" type="email" placeholder="user@example.com (optional)" class="w-full" />
          </UFormField>

          <UFormField
            label="Role"
            name="role"
            required
            description="A Member can do only what the project roles of their own and their groups allow."
          >
            <USelect v-model="newUser.role" :items="roleOptions" class="w-full" />
          </UFormField>

          <UFormField label="Groups" name="groupIds" description="Optional — the user holds every role of their groups">
            <UserGroupsSelect
              :model-value="newUser.groupIds ?? []"
              :groups="groups"
              aria-label="Groups"
              @update:model-value="newUser.groupIds = $event"
            />
          </UFormField>
        </UForm>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton type="button" color="neutral" variant="ghost" label="Cancel" @click="isAddUserModalOpen = false" />
          <UButton type="submit" label="Create user" icon="i-lucide-user-plus" @click="handleAddUser" />
        </div>
      </template>
    </UModal>
  </ClientOnly>

  <!-- API keys, through the shared <ApiKeysManager> -->
  <ClientOnly>
    <UModal
      :open="isApiKeysModalOpen"
      :title="`API keys – ${selectedUserForKeys?.username}`"
      size="xl"
      @update:open="isApiKeysModalOpen = $event"
    >
      <template #title>
        <span class="inline-flex items-center gap-1">
          API keys – {{ selectedUserForKeys?.username }}
          <HelpHint topic="settings.api-keys" />
        </span>
      </template>
      <template #body>
        <ApiKeysManager v-if="selectedUserForKeys" :user-id="selectedUserForKeys.id" />
      </template>

      <template #footer>
        <UButton color="neutral" variant="ghost" label="Close" @click="isApiKeysModalOpen = false" />
      </template>
    </UModal>
  </ClientOnly>

  <!-- Delete confirmation -->
  <ClientOnly>
    <UModal :open="isDeleteUserConfirmOpen" title="Delete user" @update:open="isDeleteUserConfirmOpen = $event">
      <template #body>
        <p>
          Are you sure you want to delete user <strong>{{ userToDelete?.username }}</strong
          >? This action cannot be undone.
        </p>
      </template>

      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="isDeleteUserConfirmOpen = false" />
        <UButton color="error" label="Delete user" icon="i-lucide-trash-2" @click="confirmDeleteUser" />
      </template>
    </UModal>
  </ClientOnly>

  <!-- Project roles of one user -->
  <ClientOnly>
    <UModal
      :open="isRolesModalOpen"
      :title="`Project roles – ${rolesUser?.username}`"
      size="xl"
      @update:open="isRolesModalOpen = $event"
    >
      <template #title>
        <span class="inline-flex items-center gap-1">
          Project roles – {{ rolesUser?.username }}
          <HelpHint topic="settings.permissions" />
        </span>
      </template>
      <template #body>
        <LoadingState v-if="rolesLoading" text="Loading project roles…" />
        <div v-else class="space-y-5" data-shot="user-project-roles">
          <UFormField
            label="All projects"
            description="Held on every project, including ones created later"
            name="allProjects"
          >
            <USelect v-model="allProjectsChoice" :items="allProjectsItems" class="w-full sm:w-56" />
          </UFormField>

          <div class="space-y-2">
            <p class="text-sm font-semibold text-highlighted">Projects</p>
            <p v-if="projectRoles.length === 0" class="text-sm text-muted">No role on a single project.</p>
            <ul v-else class="divide-y divide-default">
              <li
                v-for="entry in projectRoles"
                :key="entry.projectId"
                class="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <span class="min-w-0 break-words text-sm text-highlighted">{{ projectName(entry.projectId) }}</span>
                <div class="flex items-center gap-1">
                  <USelect
                    v-model="entry.role"
                    :items="roleItems"
                    class="w-full sm:w-44"
                    :aria-label="`Role on ${projectName(entry.projectId)}`"
                  />
                  <UButton
                    icon="i-lucide-x"
                    color="neutral"
                    variant="ghost"
                    :title="`Remove the role on ${projectName(entry.projectId)}`"
                    :aria-label="`Remove the role on ${projectName(entry.projectId)}`"
                    @click="removeProjectRole(entry.projectId)"
                  />
                </div>
              </li>
            </ul>
            <USelectMenu
              v-if="projectsToAdd.length > 0"
              :model-value="undefined"
              :items="projectsToAdd"
              value-key="value"
              placeholder="Add a project…"
              :search-input="{ placeholder: 'Filter projects…' }"
              class="w-full sm:w-64"
              aria-label="Add a project"
              @update:model-value="addProjectRole"
            />
          </div>

          <p class="text-xs text-muted">
            <template v-if="inheritedGroups.length">
              Also holds the roles of {{ inheritedGroups.map((g) => g.name).join(', ') }}, set on the
            </template>
            <template v-else>Roles given to a group apply to its members; set them on the</template>
            <NuxtLink
              to="/settings/permissions"
              class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
              >permission grid</NuxtLink
            >
            or in a project’s members.
          </p>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="isRolesModalOpen = false" />
          <UButton
            label="Save"
            icon="i-lucide-check"
            :loading="rolesSaving"
            :disabled="rolesLoading"
            @click="handleSaveProjectRoles"
          />
        </div>
      </template>
    </UModal>
  </ClientOnly>
</template>
