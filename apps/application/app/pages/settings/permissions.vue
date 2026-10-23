<script setup lang="ts">
import { PROJECT_ROLE_LABELS, type ProjectRole } from '#shared/permissions';
import {
  accessSubjectKey,
  boundRole,
  indexProjectAccessBindings,
  matchesProjectAccessQuery,
  projectAccessCellKey,
  projectAccessProjectName,
  projectAccessRows,
  withRoleBinding,
  withSubjectBindings,
  type AccessSubject,
  type ProjectAccessResponse,
  type ProjectAccessUpdateResponse,
  type RoleBindingView,
} from '#shared/project-access';

const { data, error, refresh } = await useFetch<ProjectAccessResponse>('/api/project-access');
const toast = useToast();
const { refreshDemoAccess } = useAuth();

// A local copy of the bindings, so a pick shows at once while its save is in flight.
const bindings = ref<RoleBindingView[]>([]);
watch(
  () => data.value?.bindings,
  (rows) => {
    bindings.value = rows ? [...rows] : [];
  },
  { immediate: true },
);
const users = computed(() => data.value?.users ?? []);
const groups = computed(() => data.value?.groups ?? []);
const projects = computed(() => data.value?.projects ?? []);
const rows = computed(() => projectAccessRows({ users: users.value, groups: groups.value }));

const subjectQuery = ref('');
const projectQuery = ref('');
const visibleRows = computed(() =>
  rows.value.filter((row) =>
    matchesProjectAccessQuery(
      subjectQuery.value,
      'group' in row ? [row.group.name, row.group.description] : [row.user.name, row.user.username],
    ),
  ),
);
const visibleProjects = computed(() =>
  projects.value.filter((project) => matchesProjectAccessQuery(projectQuery.value, [project.label, project.name])),
);

function countOf(visible: number, total: number, noun: string): string {
  const counted = `${total} ${noun}${total === 1 ? '' : 's'}`;
  return visible === total ? counted : `${visible} of ${counted}`;
}

const countLine = computed(() => {
  const visibleGroups = visibleRows.value.filter((row) => row.subject.type === 'group').length;
  return [
    countOf(visibleGroups, groups.value.length, 'group'),
    countOf(visibleRows.value.length - visibleGroups, users.value.length, 'user'),
    countOf(visibleProjects.value.length, projects.value.length, 'project'),
  ].join(' · ');
});

// ── Saving: each pick is its own request ──────────────────────────────────
const saving = reactive(new Set<string>());
/** Read out by screen readers after each saved change. */
const announcement = ref('');

function subjectName(subject: AccessSubject): string {
  return rows.value.find((row) => row.subject.type === subject.type && row.subject.id === subject.id)?.name ?? '';
}

function targetName(projectId: number | null): string {
  if (projectId === null) return 'all projects';
  const project = projects.value.find((p) => p.id === projectId);
  return project ? projectAccessProjectName(project) : 'the project';
}

async function onChange(subject: AccessSubject, projectId: number | null, role: ProjectRole | null) {
  const key = projectAccessCellKey(subject, projectId);
  if (saving.has(key)) return;
  const previous = boundRole(indexProjectAccessBindings(bindings.value), subject, projectId);

  bindings.value = withRoleBinding(bindings.value, { subject, projectId, role });
  saving.add(key);
  try {
    const response = await $fetch<ProjectAccessUpdateResponse>('/api/project-access', {
      method: 'PUT',
      body: { subject, projectId, role },
    });
    saving.delete(key);
    // Take the server's bindings once no other change of this subject is still in flight.
    const prefix = `${accessSubjectKey(subject)}:`;
    if (![...saving].some((k) => k.startsWith(prefix))) {
      bindings.value = withSubjectBindings(bindings.value, subject, response.bindings);
    }
    const name = subjectName(subject);
    announcement.value = role
      ? `${name} is now ${PROJECT_ROLE_LABELS[role]} on ${targetName(projectId)}`
      : `${name} no longer has a role on ${targetName(projectId)}`;
    void refreshDemoAccess();
  } catch (err) {
    saving.delete(key);
    bindings.value = withRoleBinding(bindings.value, { subject, projectId, role: previous });
    toast.add({ title: 'Role not changed', description: errorMessage(err), color: 'error' });
    // The user or group may have been deleted, or the user promoted, meanwhile: reload the grid.
    await refresh();
  }
}
</script>

<template>
  <div class="space-y-6" data-tour="permissions-page">
    <UAlert
      v-if="data && !data.authEnabled"
      icon="i-lucide-info"
      color="neutral"
      variant="subtle"
      title="Authentication is disabled"
      description="Project roles apply once authentication is enabled with PIWI_AUTH_ENABLED. Until then every visitor can do everything on every project."
    />

    <SectionCard
      title="Permissions"
      help="settings.permissions"
      data-shot="permission-grid"
      data-tour="permission-grid"
    >
      <ErrorState v-if="error" :text="`Couldn't load the permission grid: ${errorMessage(error)}`">
        <template #action>
          <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
            Retry
          </UButton>
        </template>
      </ErrorState>

      <EmptyState
        v-else-if="rows.length === 0"
        text="No users or groups yet. Add them under Users and Groups, then give them roles here."
      >
        <UButton to="/settings/users" size="sm" color="neutral" variant="outline" label="Open Users" />
      </EmptyState>

      <div v-else class="space-y-4">
        <FilterToolbar>
          <template #start>
            <span class="text-xs text-muted">{{ countLine }}</span>
          </template>
          <UInput
            v-model="subjectQuery"
            icon="i-lucide-search"
            placeholder="Filter users and groups"
            aria-label="Filter users and groups"
            size="sm"
            class="w-full sm:w-52"
          />
          <UInput
            v-model="projectQuery"
            icon="i-lucide-search"
            placeholder="Filter projects"
            aria-label="Filter projects"
            size="sm"
            class="w-full sm:w-44"
          />
        </FilterToolbar>

        <ProjectAccessGrid
          v-if="visibleRows.length > 0"
          :rows="visibleRows"
          :projects="visibleProjects"
          :users="users"
          :groups="groups"
          :bindings="bindings"
          :saving="saving"
          @change="onChange"
        />
        <EmptyState v-else text="No user or group matches this filter." />

        <p v-if="projects.length === 0" class="text-xs text-muted">
          No projects yet — each project gets a column once its first results arrive.
        </p>
        <p v-else-if="visibleProjects.length === 0" class="text-xs text-muted">No project matches this filter.</p>
      </div>

      <p class="sr-only" aria-live="polite">{{ announcement }}</p>
    </SectionCard>
  </div>
</template>
