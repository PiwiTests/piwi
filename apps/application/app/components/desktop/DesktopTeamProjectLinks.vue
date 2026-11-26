<script setup lang="ts">
/**
 * Settings → Team instance: the folders linked to the team instance's projects. Each project of this app with a folder
 * on this machine, with the team project that folder is linked to: Compare with team instance compares a test with the
 * CI of that team project, and Run on my machine runs that project's requests there. Picking a team project links the
 * folder through the shell, which reads the folder from its own links: the window names the two projects alone. Then
 * the folders a request linked that no project of this app has, each with **Unlink**. Shown while the app is connected.
 */
import type { DesktopTeamProjects } from '~~/server/utils/desktop-team-projects';

const { connection, connected, folders: teamFolders, loadFolders, unlink } = useDesktopTeamConnection();
const toast = useToast();

const { data, status, refresh } = useFetch<DesktopTeamProjects>('/api/desktop/team/projects', {
  key: 'desktop-team-projects',
  server: false,
  lazy: true,
  immediate: false,
});
// The links change as a request links a folder, an Unlink, or a connection to another instance; the projects list
// as the connection comes online.
watch(
  () => [
    connected.value,
    connection.value.state,
    connection.value.instance,
    connection.value.linkedProjectIds.join(','),
  ],
  () => {
    if (connected.value) void refresh();
  },
  { immediate: true },
);

const listedName = (id: number) =>
  data.value?.status === 'ok' ? data.value.teamProjects.find((project) => project.id === id)?.name : undefined;
const teamName = (id: number) => listedName(id) ?? connection.value.projectNames[id] ?? `Project ${id}`;

/** The team projects to pick from: the listed ones, and a linked one the list leaves out, so it still shows. */
const items = computed(() => {
  if (data.value?.status !== 'ok') return [];
  const listed = data.value.teamProjects.map((project) => ({ label: project.name, value: project.id }));
  const known = new Set(listed.map((item) => item.value));
  const linked = data.value.folders.flatMap((folder) =>
    folder.teamProjectId !== null && !known.has(folder.teamProjectId)
      ? [{ label: teamName(folder.teamProjectId), value: folder.teamProjectId }]
      : [],
  );
  return [...listed, ...linked];
});

/** The folders a request linked that are no project's folder of this app, by the team project they are linked to. */
const otherFolders = computed(() => {
  const own = new Set((data.value?.folders ?? []).flatMap((folder) => folder.teamProjectIds));
  return Object.entries(teamFolders.value)
    .filter(([teamProjectId]) => !own.has(Number(teamProjectId)))
    .map(([teamProjectId, folder]) => ({ teamProjectId: Number(teamProjectId), folder }))
    .sort((a, b) => teamName(a.teamProjectId).localeCompare(teamName(b.teamProjectId)));
});

/** The row whose link is changing: a project of this app, or a team project of another folder. */
const busy = ref<string | null>(null);

async function change(row: string, action: () => Promise<unknown>) {
  if (busy.value !== null) return;
  busy.value = row;
  try {
    await action();
  } catch (error) {
    toast.add({ title: 'The link was not changed', description: errorMessage(error), color: 'error' });
  } finally {
    await Promise.all([refresh(), loadFolders()]);
    busy.value = null;
  }
}

/** Unlink every team project a project's folder is linked to: requests may have linked it to several. */
function unlinkAll(projectId: number, teamProjectIds: number[]) {
  void change(`project-${projectId}`, async () => {
    for (const id of teamProjectIds) await unlink(String(id));
  });
}

function link(projectId: number, teamProjectId: number) {
  const core = tauriCore();
  if (!core) return;
  void change(`project-${projectId}`, () =>
    core.invoke<string>('desktop_link_team_project', {
      teamProjectId: String(teamProjectId),
      localProjectId: String(projectId),
    }),
  );
}

const problem = computed(() => {
  const answer = data.value;
  if (answer?.status !== 'unavailable') return null;
  if (answer.problem === 'reconnect') {
    return 'This connection was made before the app could list the team instance’s projects: disconnect, then connect again.';
  }
  if (answer.problem === 'not-supported')
    return 'The team instance cannot list its projects yet: it needs a newer Piwi.';
  return answer.message;
});
</script>

<template>
  <SectionCard
    v-if="connected"
    icon="i-lucide-folder-git-2"
    title="Projects and team projects"
    data-shot="desktop-team-project-links"
  >
    <template #subtitle>
      Link each project's folder to its project on the team instance, to compare a test that fails here with that
      project's CI. Run on my machine runs that project's requests in the same folder.
    </template>
    <LoadingState v-if="!data && (status === 'idle' || status === 'pending')" />
    <ErrorState v-else-if="!data && status === 'error'" text="The projects linked to the team instance did not load." />
    <div v-else-if="data" class="space-y-3">
      <p v-if="problem" class="text-xs text-muted">{{ problem }}</p>
      <p v-if="!data.folders.length" class="text-sm text-highlighted leading-relaxed">
        No project of this app has a folder on this machine yet: link one on the project's page, then come back here.
      </p>
      <ul v-else class="divide-y divide-default rounded-md border border-default" data-testid="team-project-links">
        <li
          v-for="folder in data.folders"
          :key="folder.projectId"
          class="flex min-w-0 flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
        >
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold text-highlighted">{{ folder.projectName }}</div>
            <code class="block text-xs break-all text-muted">{{ folder.folder }}</code>
          </div>
          <div class="flex items-center gap-2">
            <USelectMenu
              v-if="data.status === 'ok'"
              :model-value="folder.teamProjectId ?? undefined"
              :items="items"
              value-key="value"
              placeholder="Not linked"
              :loading="busy === `project-${folder.projectId}`"
              :disabled="busy !== null"
              class="w-full sm:w-64"
              :aria-label="`Team project of ${folder.projectName}`"
              @update:model-value="(value: number) => link(folder.projectId, value)"
            />
            <span v-else class="text-xs text-muted">{{
              folder.teamProjectId === null ? 'Not linked' : teamName(folder.teamProjectId)
            }}</span>
            <UButton
              v-if="folder.teamProjectId !== null"
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-unlink"
              :disabled="busy !== null"
              @click="unlinkAll(folder.projectId, folder.teamProjectIds)"
              >Unlink</UButton
            >
          </div>
        </li>
      </ul>
      <template v-if="otherFolders.length">
        <div class="text-xs text-muted">Other folders a run request linked</div>
        <ul class="divide-y divide-default rounded-md border border-default" data-testid="team-other-folders">
          <li
            v-for="other in otherFolders"
            :key="other.teamProjectId"
            class="flex min-w-0 items-center gap-3 px-3 py-2"
          >
            <div class="min-w-0 flex-1">
              <div class="text-sm font-semibold text-highlighted">{{ teamName(other.teamProjectId) }}</div>
              <code class="block text-xs break-all text-muted">{{ other.folder }}</code>
            </div>
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-unlink"
              :disabled="busy !== null"
              @click="change(`team-${other.teamProjectId}`, () => unlink(String(other.teamProjectId)))"
              >Unlink</UButton
            >
          </li>
        </ul>
      </template>
    </div>
  </SectionCard>
</template>
