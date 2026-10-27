<script setup lang="ts">
import {
  INSTANCE_PERMISSIONS,
  PERMISSION_LABELS,
  PROJECT_PERMISSIONS,
  PROJECT_ROLES,
  PROJECT_ROLE_DESCRIPTIONS,
  PROJECT_ROLE_LABELS,
  roleGrants,
  type ProjectPermission,
  type ProjectRole,
} from '#shared/permissions';

// A read-only view of `shared/permissions.ts`: what each role allows, built from
// the same matrix the server enforces, so it cannot drift from it.
const { canSeeAdmin } = useAuth();

const rows = PROJECT_PERMISSIONS.map((permission) => ({
  permission,
  label: PERMISSION_LABELS[permission],
  roles: PROJECT_ROLES.filter((role) => roleGrants(role, permission)),
}));

function permissionsOf(role: ProjectRole): ProjectPermission[] {
  return PROJECT_PERMISSIONS.filter((permission) => roleGrants(role, permission));
}

const instanceRows = INSTANCE_PERMISSIONS.map((permission) => ({ permission, label: PERMISSION_LABELS[permission] }));
</script>

<template>
  <div class="space-y-6" data-tour="roles-page">
    <SectionCard
      title="Project roles"
      subtitle="Held on one project or on all projects, directly or through a group. A user's rights on a project are the union of every role they hold there."
      help="settings.roles"
      data-shot="roles-matrix"
      data-tour="project-roles-matrix"
    >
      <dl class="grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr] mb-6">
        <template v-for="role in PROJECT_ROLES" :key="role">
          <dt class="text-sm font-semibold text-highlighted">{{ PROJECT_ROLE_LABELS[role] }}</dt>
          <dd class="text-sm text-highlighted leading-relaxed mb-2 sm:mb-0">{{ PROJECT_ROLE_DESCRIPTIONS[role] }}</dd>
        </template>
      </dl>

      <!-- Phone: one card per role, listing what it allows. -->
      <ul class="space-y-3 md:hidden">
        <li v-for="role in PROJECT_ROLES" :key="role" class="rounded-lg border border-default p-3">
          <p class="text-sm font-semibold text-highlighted">{{ PROJECT_ROLE_LABELS[role] }}</p>
          <ul class="mt-1 space-y-1">
            <li v-for="permission in permissionsOf(role)" :key="permission" class="text-sm text-highlighted">
              {{ PERMISSION_LABELS[permission] }}
              <span class="text-xs text-muted font-mono">{{ permission }}</span>
            </li>
          </ul>
        </li>
      </ul>

      <div class="hidden md:block overflow-x-auto">
        <table class="w-full text-sm" aria-label="What each project role can do">
          <thead>
            <tr class="border-b border-default">
              <th scope="col" class="py-2 pr-4 text-left font-semibold text-highlighted">What you can do</th>
              <th scope="col" class="py-2 pr-4 text-left font-semibold text-highlighted">Permission</th>
              <th
                v-for="role in PROJECT_ROLES"
                :key="role"
                scope="col"
                class="py-2 px-2 text-center font-semibold text-highlighted whitespace-nowrap"
              >
                {{ PROJECT_ROLE_LABELS[role] }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.permission" class="border-b border-default last:border-b-0">
              <th scope="row" class="py-2 pr-4 text-left font-normal text-highlighted">{{ row.label }}</th>
              <td class="py-2 pr-4 text-xs text-muted font-mono whitespace-nowrap">{{ row.permission }}</td>
              <td v-for="role in PROJECT_ROLES" :key="role" class="py-2 px-2 text-center">
                <template v-if="row.roles.includes(role)">
                  <UIcon name="i-lucide-check" class="size-4 text-highlighted align-middle" aria-hidden="true" />
                  <span class="sr-only">{{ PROJECT_ROLE_LABELS[role] }} can {{ row.label.toLowerCase() }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </SectionCard>

    <SectionCard
      title="Administrator"
      subtitle="An instance role, granted to a user on their own row in Settings → Users, never through a group. An Administrator can do everything on every project, and alone holds these permissions."
      data-shot="roles-instance"
      data-tour="administrator-role"
    >
      <ul class="space-y-1">
        <li v-for="row in instanceRows" :key="row.permission" class="text-sm text-highlighted">
          {{ row.label }}
          <span class="text-xs text-muted font-mono">{{ row.permission }}</span>
        </li>
      </ul>
    </SectionCard>

    <p class="text-xs text-muted">
      The roles are fixed. To give someone rights, grant them a role
      <NuxtLink
        v-if="canSeeAdmin"
        to="/settings/permissions"
        class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >on the permission grid</NuxtLink
      ><template v-else>on the permission grid (administrators) or in a project's Members (Project admins)</template>;
      rights add up across a user's roles and groups.
    </p>
  </div>
</template>
