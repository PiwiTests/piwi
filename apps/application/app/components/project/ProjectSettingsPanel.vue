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
import {
  PROJECT_SETTINGS_GROUPS,
  PROJECT_SETTINGS_SECTIONS,
  type ProjectSettingsSection,
  type ProjectSettingsSectionId,
} from '#shared/app-places';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

type SectionId = ProjectSettingsSectionId;
const SECTION_IDS: readonly SectionId[] = PROJECT_SETTINGS_SECTIONS.map((section) => section.id);

interface Section extends ProjectSettingsSection {
  id: SectionId;
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

// Which sections this viewer sees; the list and its order are the places registry's.
const sectionVisible = computed<Record<SectionId, boolean>>(() => ({
  general: true,
  status: canManage.value,
  members: canSeeMembers.value,
  'source-control': true,
  ai: true,
  'live-view': canManage.value && !isDesktop,
  'run-variables': canManage.value,
  environments: true,
  capabilities: canDecide.value,
  coverage: canManage.value && (!isHidden('coverage') || showOpenApi.value || showServerProbes.value),
  targets: canManage.value,
  'issue-tracker': canManage.value,
  ci: canManage.value,
  'tag-keys': canManage.value,
  'test-management': canManage.value,
  'browser-extension': canManage.value,
  'local-folder': isDesktop || hasBridge.value,
}));
const sections = computed<Section[]>(() =>
  PROJECT_SETTINGS_SECTIONS.map((section) => ({ ...section, visible: sectionVisible.value[section.id] })),
);
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
  PROJECT_SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: visibleSections.value.filter((s) => s.group === group.id),
  })).filter((group) => group.items.length > 0),
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
      <ProjectGeneralSettings
        v-if="active === 'general'"
        :project="project"
        data-tour="project-settings-general"
        @saved="emit('saved')"
      />

      <ProjectStatusFilterSettings
        v-else-if="active === 'status'"
        :project="project"
        data-tour="project-settings-status"
        @saved="emit('saved')"
      />

      <ProjectMembersSettings
        v-else-if="active === 'members'"
        :project-id="project.id"
        data-tour="project-settings-members"
      />

      <ProjectSourceControlSettings
        v-else-if="active === 'source-control'"
        :project="project"
        :show-generated-specs="!isHidden('bug-reports')"
        data-tour="project-settings-source-control"
        @saved="emit('saved')"
      />

      <ProjectAiSettings
        v-else-if="active === 'ai'"
        :project="project"
        data-tour="project-settings-ai"
        @saved="emit('saved')"
      />

      <ProjectLiveViewSettings
        v-else-if="active === 'live-view'"
        :project="project"
        data-tour="project-settings-live-view"
        @saved="emit('saved')"
      />

      <ProjectRunVariablesSettings
        v-else-if="active === 'run-variables'"
        :project="project"
        data-tour="project-settings-run-variables"
        @saved="emit('saved')"
      />

      <div v-else-if="active === 'environments'" class="space-y-4">
        <ProjectEnvironmentsSettings
          :project="project"
          data-tour="project-settings-environments"
          @saved="emit('saved')"
        />
        <ProjectDefaultEnvironmentSettings :project="project" @saved="emit('saved')" />
      </div>

      <div v-else-if="active === 'capabilities'" data-tour="project-settings-capabilities">
        <ProjectCapabilityDecisions
          :project-id="project.id"
          :initial="project.capabilities ?? null"
          @changed="emit('saved')"
        />
      </div>

      <div v-else-if="active === 'coverage'" class="space-y-4" data-tour="project-settings-coverage">
        <ProjectCoverageSettings v-if="!isHidden('coverage')" :project="project" @saved="emit('saved')" />
        <ProjectGapsSettings
          :project="project"
          :show-open-api="showOpenApi"
          :show-server-probes="showServerProbes"
          @saved="emit('saved')"
        />
      </div>

      <ProjectTargetsForm
        v-else-if="active === 'targets'"
        :project-id="project.id"
        :targets="project.targets ?? null"
        data-tour="project-settings-targets"
        @saved="emit('saved')"
      />

      <ProjectIntegrationSettings
        v-else-if="active === 'issue-tracker'"
        :project-id="project.id"
        data-tour="project-settings-issue-tracker"
      />

      <ProjectCiSettings
        v-else-if="active === 'ci'"
        :project="project"
        data-tour="project-settings-ci"
        @saved="emit('saved')"
      />

      <ProjectTagKeysSettings
        v-else-if="active === 'tag-keys'"
        :project="project"
        data-tour="project-settings-tag-keys"
        @saved="emit('saved')"
      />

      <ProjectTestManagementSettings
        v-else-if="active === 'test-management'"
        :project-id="project.id"
        data-tour="project-settings-test-management"
      />

      <ProjectUrlPatternsForm
        v-else-if="active === 'browser-extension'"
        :project-id="project.id"
        data-tour="project-settings-browser-extension"
      />

      <DesktopProjectFolderSection
        v-else-if="active === 'local-folder'"
        :project-id="project.id"
        :project-name="project.name"
        data-tour="project-settings-local-folder"
      />
    </div>
  </div>
</template>
