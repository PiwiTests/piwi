<script setup lang="ts">
/**
 * Project settings → Members (`project:members` holders): every group and user
 * holding a role on this project, with where it comes from. A role granted on
 * this project is edited here (changed or removed, and new members added),
 * within the roles the viewer may grant; a role held on all projects, through
 * a group or as an administrator is shown read-only with its source. Each
 * change saves at once.
 */
import { PROJECT_ROLE_LABELS, ProjectRole } from '#shared/permissions';
import { foldText } from '#shared/utils/fold-text';
import {
  accessSubjectKey,
  directProjectMemberEntries,
  projectAccessUserName,
  sortProjectAccessGroups,
  sortProjectAccessUsers,
  type AccessSubject,
  type GroupListItem,
  type GroupsListResponse,
  type ProjectMembersResponse,
  type ProjectMembersUpdate,
  type ProjectMembersUpdateResponse,
  type ProjectMemberView,
  type UserSummary,
  type UsersListResponse,
} from '#shared/project-access';

const props = defineProps<{ projectId: number }>();

const toast = useToast();
const { can, refreshDemoAccess } = useAuth();
const response = ref<ProjectMembersResponse | null>(null);
const loadError = ref<unknown>(null);
const loading = ref(true);
const saving = ref(false);
const users = ref<UserSummary[]>([]);
const groups = ref<GroupListItem[]>([]);
/** Read out by screen readers after each saved change. */
const announcement = ref('');

const members = computed(() => response.value?.members ?? []);
const canManage = computed(() => response.value?.canManage ?? false);
const grantableRoles = computed(() => response.value?.grantableRoles ?? []);

/** One subject, with its role on this project (`direct`) and the roles it holds from elsewhere. */
interface MemberRow {
  key: string;
  subject: AccessSubject;
  name: string;
  username: string | null;
  direct: ProjectRole | null;
  others: ProjectMemberView[];
  admin: boolean;
}

const rows = computed<MemberRow[]>(() => {
  const byKey = new Map<string, MemberRow>();
  for (const member of members.value) {
    const key = accessSubjectKey(member.subject);
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        subject: member.subject,
        name: member.name,
        username: member.username,
        direct: null,
        others: [],
        admin: false,
      };
      byKey.set(key, row);
    }
    if (member.source === 'direct') row.direct = member.role;
    else row.others.push(member);
    if (member.source === 'administrator') row.admin = true;
  }
  return [...byKey.values()];
});

const roleItems = computed(() => projectRoleSelectItems(grantableRoles.value));

function canEdit(row: MemberRow): boolean {
  return canManage.value && row.direct !== null && grantableRoles.value.includes(row.direct);
}

/** The role a read-only row shows: its own, else the strongest one it holds from elsewhere. */
function shownRoleOf(row: MemberRow): ProjectRole | null {
  return row.direct ?? strongestProjectRole(row.others.map((other) => other.role));
}

function shownRole(row: MemberRow): string {
  if (row.admin) return 'Administrator';
  const role = shownRoleOf(row);
  return role ? PROJECT_ROLE_LABELS[role] : '';
}

/**
 * Under the name: the username, then where each role held from elsewhere comes
 * from ("Maintainer through QA"); the role already shown beside the row only
 * gets its source ("through QA").
 */
function rowMeta(row: MemberRow): string {
  const parts = [row.subject.type === 'group' ? 'Group' : row.username ? `@${row.username}` : ''];
  if (!row.admin) {
    const shown = row.direct === null ? shownRoleOf(row) : null;
    for (const other of row.others) {
      const source = projectMemberSourceText(other);
      parts.push(other.role === shown ? source : `${PROJECT_ROLE_LABELS[other.role]} ${source}`);
    }
  }
  return parts.filter(Boolean).join(' · ');
}

// ── Loading ─────────────────────────────────────────────────────────────────
async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    response.value = await $fetch<ProjectMembersResponse>(`/api/projects/${props.projectId}/members`);
    if (response.value.canManage) await loadPickers();
  } catch (err) {
    loadError.value = err;
  } finally {
    loading.value = false;
  }
}

/** The users and groups the add picker offers; a failure leaves it empty rather than failing the list. */
async function loadPickers() {
  const [userList, groupList] = await Promise.all([
    $fetch<UsersListResponse>('/api/users').catch(() => null),
    $fetch<GroupsListResponse>('/api/groups').catch(() => null),
  ]);
  users.value = sortProjectAccessUsers([...(userList?.items ?? [])]);
  groups.value = sortProjectAccessGroups(groupList?.groups ?? []);
}

/** What the add picker's search box holds. */
const addSearch = ref('');

/**
 * A project admin's list holds the users who share a project with them; anyone
 * else is found by their whole username, looked up as it is typed.
 * Administrators already list everyone.
 */
const lookUpUsername = useDebounceFn(async (term: string) => {
  const username = term.trim();
  if (!username || can('users:manage') || users.value.some((user) => user.username === username)) return;
  const found = await $fetch<UsersListResponse>('/api/users', { query: { lookup: username } }).catch(() => null);
  const listed = new Set(users.value.map((user) => user.id));
  const added: UserSummary[] = [...(found?.items ?? [])].filter((user) => !listed.has(user.id));
  if (added.length > 0) users.value = sortProjectAccessUsers([...users.value, ...added]);
}, 300);
watch(addSearch, lookUpUsername);

watch(() => props.projectId, load, { immediate: true });

// ── Saving: every change replaces the direct roles at once ─────────────────
async function save(entries: ProjectMembersUpdate['entries'], done: string) {
  saving.value = true;
  try {
    const result = await $fetch<ProjectMembersUpdateResponse>(`/api/projects/${props.projectId}/members`, {
      method: 'PUT',
      body: { entries },
    });
    if (response.value) response.value = { ...response.value, members: result.members };
    announcement.value = done;
    void refreshDemoAccess();
  } catch (err) {
    toast.add({ title: 'Members not changed', description: errorMessage(err), color: 'error' });
    await load();
  } finally {
    saving.value = false;
  }
}

function setRole(row: MemberRow, role: ProjectRole) {
  if (role === row.direct) return;
  const entries = directProjectMemberEntries(members.value).map((entry) =>
    accessSubjectKey(entry.subject) === row.key ? { ...entry, role } : entry,
  );
  void save(entries, `${row.name} is now ${PROJECT_ROLE_LABELS[role]} on this project`);
}

function remove(row: MemberRow) {
  const entries = directProjectMemberEntries(members.value).filter(
    (entry) => accessSubjectKey(entry.subject) !== row.key,
  );
  void save(entries, `${row.name} no longer has a role of their own on this project`);
}

// ── Adding a user or a group ────────────────────────────────────────────────
const addKey = ref<string | undefined>(undefined);
const addRole = ref<ProjectRole>(ProjectRole.VIEWER);
watch(grantableRoles, (roles) => {
  if (roles.length > 0 && !roles.includes(addRole.value)) addRole.value = roles[0]!;
});

/** Subjects already holding a role here, and administrators, who need none. */
const unavailable = computed(
  () => new Set(rows.value.filter((row) => row.direct !== null || row.admin).map((row) => row.key)),
);

const addItems = computed(() => {
  // A username is often pasted, surrounding spaces included.
  const term = foldText(addSearch.value.trim());
  const matches = (...texts: (string | null)[]) =>
    !term || texts.some((text) => text !== null && foldText(text).includes(term));
  const groupItems = groups.value
    .filter((group) => matches(group.name))
    .map((group) => ({ label: group.name, value: `group:${group.id}`, description: 'Group' }))
    .filter((item) => !unavailable.value.has(item.value));
  const userItems = users.value
    .filter((user) => matches(user.name, user.username))
    .map((user) => ({
      label: projectAccessUserName(user),
      value: `user:${user.id}`,
      description: user.name ? `@${user.username}` : undefined,
    }))
    .filter((item) => !unavailable.value.has(item.value));
  // Groups first, then users, apart.
  return [groupItems, userItems].filter((items) => items.length > 0);
});

function subjectOfKey(key: string): AccessSubject | null {
  const [type, id] = key.split(':');
  if ((type !== 'user' && type !== 'group') || !id) return null;
  return { type, id: Number(id) };
}

function add() {
  const subject = addKey.value ? subjectOfKey(addKey.value) : null;
  if (!subject) return;
  const item = addItems.value.flat().find((i) => i.value === addKey.value);
  const name = item?.label ?? '';
  // A user goes with their username, which names someone the viewer's own list leaves out.
  const username = subject.type === 'user' ? users.value.find((user) => user.id === subject.id)?.username : undefined;
  const entries = [
    ...directProjectMemberEntries(members.value),
    { subject: { ...subject, username }, role: addRole.value },
  ];
  addKey.value = undefined;
  void save(entries, `${name} is now ${PROJECT_ROLE_LABELS[addRole.value]} on this project`);
}
</script>

<template>
  <SectionCard
    icon="i-lucide-users"
    title="Members"
    help="project.members"
    subtitle="Who holds a role on this project"
    data-shot="project-members"
  >
    <LoadingState v-if="loading" text="Loading members…" />
    <ErrorState v-else-if="loadError" :text="`Couldn't load the members: ${errorMessage(loadError)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="load()">
          Retry
        </UButton>
      </template>
    </ErrorState>

    <div v-else class="space-y-4">
      <div v-if="canManage" class="flex flex-col gap-2 sm:flex-row sm:items-center">
        <USelectMenu
          v-model="addKey"
          v-model:search-term="addSearch"
          :items="addItems"
          ignore-filter
          value-key="value"
          placeholder="Add a user or a group…"
          :search-input="{ placeholder: 'Filter, or type a whole username…' }"
          aria-label="User or group to add"
          class="w-full sm:w-72"
        >
          <template #empty="{ searchTerm }">
            <template v-if="!searchTerm">Nobody to add.</template>
            <template v-else-if="can('users:manage')">No match.</template>
            <template v-else>
              No match. Someone who shares no project with you is found by their whole username.
            </template>
          </template>
        </USelectMenu>
        <USelect v-model="addRole" :items="roleItems" aria-label="Role to give" class="w-full sm:w-44" />
        <UButton label="Add" icon="i-lucide-plus" :disabled="!addKey || saving" @click="add" />
      </div>

      <p v-if="rows.length === 0" class="text-sm text-muted">Nobody holds a role on this project yet.</p>
      <ul v-else class="divide-y divide-default">
        <li
          v-for="row in rows"
          :key="row.key"
          class="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
          :data-member="row.key"
        >
          <div class="min-w-0">
            <p class="text-sm text-highlighted break-words">{{ row.name }}</p>
            <p v-if="rowMeta(row)" class="text-xs text-muted break-words">{{ rowMeta(row) }}</p>
          </div>

          <div v-if="canEdit(row)" class="flex items-center gap-1 sm:shrink-0">
            <USelect
              :model-value="row.direct ?? undefined"
              :items="roleItems"
              size="sm"
              :disabled="saving"
              :aria-label="`Role of ${row.name} on this project`"
              class="w-full sm:w-44"
              @update:model-value="(value) => setRole(row, value as ProjectRole)"
            />
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="sm"
              :disabled="saving"
              :title="`Remove the role of ${row.name} on this project`"
              :aria-label="`Remove ${row.name}`"
              @click="remove(row)"
            />
          </div>
          <span
            v-else
            class="text-sm sm:shrink-0"
            :class="row.direct ? 'text-highlighted' : 'text-muted'"
            :title="row.admin ? 'Administrators can do everything on every project' : undefined"
            >{{ shownRole(row) }}</span
          >
        </li>
      </ul>

      <p class="text-xs text-muted">
        Roles held on all projects or through a group are set in Settings → Permissions and Groups by an administrator.
      </p>
    </div>

    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </SectionCard>
</template>
