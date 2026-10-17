<script setup lang="ts">
/**
 * The project's Settings tab: a section menu beside one section at a time, so
 * each setting is a click away instead of somewhere down one long page. Each
 * section saves on its own. The open section is the `?section=` query; a
 * `#local-folder` link opens the Local folder section and `?tab=members` the
 * Members one. From `lg` up the menu is a vertical list; below it a full-width
 * select stands in, grouped the same way.
 */
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const SECTION_IDS = [
  'general',
  'members',
  'source-control',
  'ai',
  'capabilities',
  'coverage',
  'targets',
  'issue-tracker',
  'browser-extension',
  'local-folder',
] as const;
type SectionId = (typeof SECTION_IDS)[number];

const GROUPS = [
  { id: 'project', label: 'Project' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'integrations', label: 'Integrations' },
] as const;

interface Section {
  id: SectionId;
  label: string;
  icon: string;
  group: (typeof GROUPS)[number]['id'];
  visible: boolean;
}

const { can } = useAuth();
const runtimeConfig = useRuntimeConfig();
// The sections that only save with `project:manage` show to its holders; Members
// lists the project's role bindings, which only exist with authentication on.
const canManage = computed(() => can('project:manage', props.project.id));
const canSeeMembers = computed(
  () => Boolean(runtimeConfig.public.authEnabled) && can('project:members', props.project.id),
);
const { isHidden, canDecide } = await useProjectCapabilities(props.project.id);

// The Local folder section exists in the desktop shell only; the bridge is known once mounted.
const isDesktop = useIsDesktop();
const hasBridge = ref(false);
onMounted(() => {
  hasBridge.value = !!tauriCore();
});

const showOpenApi = computed(() => !isHidden('test-map'));
const showServerProbes = computed(() => !isHidden('server-probes'));

const sections = computed<Section[]>(() => [
  { id: 'general', label: 'General', icon: 'i-lucide-settings', group: 'project', visible: true },
  { id: 'members', label: 'Members', icon: 'i-lucide-users', group: 'project', visible: canSeeMembers.value },
  { id: 'source-control', label: 'Source control', icon: 'i-lucide-git-branch', group: 'project', visible: true },
  { id: 'ai', label: 'AI diagnosis', icon: 'i-lucide-sparkles', group: 'project', visible: true },
  {
    id: 'capabilities',
    label: 'Capabilities',
    icon: 'i-lucide-toggle-right',
    group: 'analysis',
    visible: canDecide.value || showOpenApi.value || showServerProbes.value,
  },
  {
    id: 'coverage',
    label: 'Coverage',
    icon: 'i-lucide-scan-line',
    group: 'analysis',
    visible: canManage.value && !isHidden('coverage'),
  },
  { id: 'targets', label: 'Targets', icon: 'i-lucide-target', group: 'analysis', visible: canManage.value },
  {
    id: 'issue-tracker',
    label: 'Issue tracker',
    icon: 'i-lucide-ticket',
    group: 'integrations',
    visible: canManage.value,
  },
  {
    id: 'browser-extension',
    label: 'Browser extension',
    icon: 'i-lucide-link',
    group: 'integrations',
    visible: canManage.value,
  },
  {
    id: 'local-folder',
    label: 'Local folder',
    icon: 'i-lucide-folder-symlink',
    group: 'integrations',
    visible: isDesktop || hasBridge.value,
  },
]);
const visibleSections = computed(() => sections.value.filter((s) => s.visible));

const route = useRoute();
const router = useRouter();

function requestedSection(): SectionId {
  const section = route.query.section;
  if (typeof section === 'string' && (SECTION_IDS as readonly string[]).includes(section)) {
    return section as SectionId;
  }
  if (route.hash === '#local-folder') return 'local-folder';
  if (route.query.tab === 'members') return 'members';
  return 'general';
}

const requested = ref<SectionId>(requestedSection());
// A section this viewer cannot see (or not yet: the desktop bridge) shows General meanwhile.
const active = computed<SectionId>(() =>
  visibleSections.value.some((s) => s.id === requested.value) ? requested.value : 'general',
);

function select(id: SectionId) {
  if (id === active.value) return;
  requested.value = id;
  // Replace, so switching sections does not stack history; the hash belonged to the previous section.
  router.replace({ query: { ...route.query, section: id } });
}

/** The visible sections under their group, empty groups left out — the source of both menus. */
const groupedSections = computed(() =>
  GROUPS.map((group) => ({ ...group, items: visibleSections.value.filter((s) => s.group === group.id) })).filter(
    (group) => group.items.length > 0,
  ),
);

const navItems = computed(() =>
  groupedSections.value.map((group) => [
    { type: 'label' as const, label: group.label },
    ...group.items.map((s) => ({
      label: s.label,
      icon: s.icon,
      active: active.value === s.id,
      'aria-current': active.value === s.id ? ('true' as const) : undefined,
      onSelect: () => select(s.id),
    })),
  ]),
);

type SectionSelectItem = { label: string; type?: 'label'; icon?: string; value?: SectionId };
const selectItems = computed<SectionSelectItem[]>(() =>
  groupedSections.value.flatMap((group) => [
    { type: 'label' as const, label: group.label },
    ...group.items.map((s) => ({ label: s.label, icon: s.icon, value: s.id })),
  ]),
);
const selectModel = computed({
  get: () => active.value,
  set: (id: SectionId) => select(id),
});
const activeIcon = computed(() => sections.value.find((s) => s.id === active.value)?.icon);
</script>

<template>
  <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8" data-shot="project-settings">
    <!-- Below lg: a labelled select replaces the section menu. -->
    <USelect
      v-model="selectModel"
      :items="selectItems"
      value-key="value"
      :icon="activeIcon"
      aria-label="Settings section"
      class="w-full lg:hidden"
    />
    <UNavigationMenu
      orientation="vertical"
      :items="navItems"
      aria-label="Settings sections"
      class="hidden lg:flex lg:w-52 lg:shrink-0 lg:sticky lg:top-0"
      :ui="{ separator: 'hidden' }"
    />

    <div class="min-w-0 flex-1 max-w-4xl space-y-4">
      <ProjectGeneralSettings v-if="active === 'general'" :project="project" @saved="emit('saved')" />

      <ProjectMembersSettings v-else-if="active === 'members'" :project-id="project.id" />

      <ProjectSourceControlSettings
        v-else-if="active === 'source-control'"
        :project="project"
        :show-generated-specs="!isHidden('bug-reports')"
        @saved="emit('saved')"
      />

      <ProjectAiSettings v-else-if="active === 'ai'" :project="project" @saved="emit('saved')" />

      <template v-else-if="active === 'capabilities'">
        <ProjectCapabilityDecisions
          :project-id="project.id"
          :initial="project.capabilities ?? null"
          @changed="emit('saved')"
        />
        <ProjectGapsSettings
          :project="project"
          :show-open-api="showOpenApi"
          :show-server-probes="showServerProbes"
          @saved="emit('saved')"
        />
      </template>

      <ProjectCoverageSettings v-else-if="active === 'coverage'" :project="project" @saved="emit('saved')" />

      <ProjectTargetsForm
        v-else-if="active === 'targets'"
        :project-id="project.id"
        :targets="project.targets ?? null"
        @saved="emit('saved')"
      />

      <ProjectIntegrationSettings v-else-if="active === 'issue-tracker'" :project-id="project.id" />

      <ProjectUrlPatternsForm v-else-if="active === 'browser-extension'" :project-id="project.id" />

      <DesktopProjectFolderSection
        v-else-if="active === 'local-folder'"
        :project-id="project.id"
        :project-name="project.name"
      />
    </div>
  </div>
</template>
