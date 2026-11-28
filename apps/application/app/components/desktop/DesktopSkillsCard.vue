<script setup lang="ts">
/**
 * Desktop shell only: install the Piwi workflow skills into a project's linked
 * folder (`.claude/skills/<slug>/SKILL.md`), next to the MCP client setup. The
 * server hands out each skill stamped with its version; a skill not installed
 * or untouched since an older release is written, one edited by hand is kept
 * unless replaced on purpose. Renders nothing without the IPC bridge or a
 * linked folder.
 */
import { classifyInstalledSkill, readSkillStamp, type InstalledSkillState } from '@piwitests/core/skill-stamp';
import type { ProjectMenuItem } from '~~/types/api';

interface ServedSkill {
  slug: string;
  prompt: string;
  description: string | null;
  content: string;
}
interface LinkedSkills {
  dir: string;
  files: Array<{ slug: string; content: string | null }>;
}
type RowState = InstalledSkillState | 'missing';
interface Row {
  slug: string;
  state: RowState;
  installedVersion: string | null;
  content: string;
}

const toast = useToast();

const available = ref(false);
const version = ref('');
const skills = ref<ServedSkill[]>([]);
const projects = ref<Array<{ id: number; label: string }>>([]);
const projectId = ref<number | undefined>(undefined);
const dir = ref('');
const rows = ref<Row[]>([]);
const busy = ref(false);

async function loadProjects() {
  const menu = await $fetch<{ items: ProjectMenuItem[] }>('/api/projects/menu');
  const linked: Array<{ id: number; label: string }> = [];
  for (const project of menu.items) {
    const link = await getDesktopProjectLink(project.id);
    if (link?.exists) linked.push({ id: project.id, label: project.label || project.name });
  }
  projects.value = linked;
  projectId.value = linked[0]?.id;
}

async function loadRows() {
  const core = tauriCore();
  if (!core || projectId.value == null) {
    rows.value = [];
    return;
  }
  const read = await core.invoke<LinkedSkills>('desktop_skills_read', {
    projectId: String(projectId.value),
    slugs: skills.value.map((s) => s.slug),
  });
  dir.value = read.dir;
  rows.value = skills.value.map((skill) => {
    const installed = read.files.find((f) => f.slug === skill.slug)?.content ?? null;
    return {
      slug: skill.slug,
      content: skill.content,
      state: installed == null ? 'missing' : classifyInstalledSkill(installed, skill.content),
      installedVersion: installed == null ? null : readSkillStamp(installed).version,
    };
  });
}

onMounted(async () => {
  if (!tauriCore()) return;
  try {
    const served = await $fetch<{ version: string; items: ServedSkill[] }>('/api/agent-skills');
    if (!served.items.length) return;
    version.value = served.version;
    skills.value = served.items;
    await loadProjects();
    if (!projects.value.length) return;
    available.value = true;
    await loadRows();
  } catch {
    available.value = false;
  }
});

watch(projectId, () => void loadRows().catch(() => (rows.value = [])));

/** Rows the install button writes: missing ones, and untouched ones from another release. */
const pending = computed(() => rows.value.filter((r) => r.state === 'missing' || r.state === 'outdated'));

async function write(selected: Row[]) {
  const core = tauriCore();
  if (!core || projectId.value == null || !selected.length) return;
  busy.value = true;
  try {
    await core.invoke('desktop_skills_write', {
      projectId: String(projectId.value),
      files: selected.map((r) => ({ slug: r.slug, content: r.content })),
    });
    toast.add({
      title: `${selected.length} skill${selected.length === 1 ? '' : 's'} installed`,
      description: 'Your agent picks them up the next time it starts in this folder.',
      color: 'success',
    });
    await loadRows();
  } catch (error) {
    toast.add({ title: 'Could not install the skills', description: errorMessage(error), color: 'error' });
  } finally {
    busy.value = false;
  }
}

function stateLabel(row: Row): string {
  switch (row.state) {
    case 'current':
      return `Installed (${version.value})`;
    case 'outdated':
      return `Outdated (${row.installedVersion ?? 'older release'})`;
    case 'edited':
      return 'Edited in this folder';
    case 'unstamped':
      return 'Installed, differs';
    default:
      return 'Not installed';
  }
}
</script>

<template>
  <SectionCard v-if="available" icon="i-lucide-book-open-check" title="Install the agent skills in a project folder">
    <template #subtitle>
      The Piwi workflow skills, written into the project's linked folder for your agent to read. Each one ends by
      reporting back to Piwi (the diagnosis, the fix attempt, the gap verdict).
    </template>

    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <USelect
          v-model="projectId"
          :items="projects.map((p) => ({ label: p.label, value: p.id }))"
          class="min-w-48"
          aria-label="Project"
        />
        <UButton
          size="xs"
          :disabled="!pending.length"
          :loading="busy"
          title="Write the skills not installed yet and the untouched ones from an older release"
          @click="write(pending)"
        >
          Install {{ pending.length || '' }} skill{{ pending.length === 1 ? '' : 's' }}
        </UButton>
      </div>
      <p v-if="dir" class="text-xs text-muted font-mono truncate">{{ dir }}</p>
      <ul class="space-y-1.5">
        <li v-for="row in rows" :key="row.slug" class="flex items-center gap-3" :data-testid="`skill-${row.slug}`">
          <span class="text-sm font-mono min-w-0 flex-1 truncate">{{ row.slug }}</span>
          <span class="text-xs text-muted shrink-0">{{ stateLabel(row) }}</span>
          <UButton
            v-if="row.state === 'edited' || row.state === 'unstamped'"
            size="xs"
            color="neutral"
            variant="ghost"
            :disabled="busy"
            title="Replace your edited copy with this version"
            @click="write([row])"
          >
            Replace
          </UButton>
        </li>
      </ul>
    </div>
  </SectionCard>
</template>
