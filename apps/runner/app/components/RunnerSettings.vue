<script setup lang="ts">
/**
 * The settings, one section at a time, picked in the list beside them: the connection, the linked folders (with how
 * many), the general settings (the background and the language), and About.
 */
import type { TabsItem } from '@nuxt/ui';

const section = defineModel<string>('section', { required: true });

const { folders } = useDesktopTeamConnection();
const words = useRunUiWords();
const { t } = useRunnerWords();

const linked = computed(() => Object.keys(folders.value).length);
const sections = computed<TabsItem[]>(() => [
  { label: t('runner_navConnection'), value: 'connection', icon: 'i-lucide-plug' },
  {
    label: t('runner_navFolders'),
    value: 'folders',
    icon: 'i-lucide-folder',
    badge: linked.value ? { label: words.number(linked.value), color: 'neutral', variant: 'subtle' } : undefined,
  },
  { label: t('runner_navGeneral'), value: 'general', icon: 'i-lucide-sliders-horizontal' },
  { label: t('runner_aboutHeading'), value: 'about', icon: 'i-lucide-info' },
]);
</script>

<template>
  <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6" data-testid="runner-settings">
    <UTabs
      :model-value="section"
      :items="sections"
      :content="false"
      orientation="vertical"
      variant="link"
      size="sm"
      activation-mode="manual"
      class="shrink-0 sm:sticky sm:top-24 sm:w-44"
      :ui="{ list: 'w-full', trigger: 'justify-start' }"
      @update:model-value="section = String($event)"
    />
    <div class="min-w-0 flex-1 space-y-4">
      <RunnerSection
        v-if="section === 'connection'"
        icon="i-lucide-monitor-play"
        :title="t('runner_connectionHeading')"
        :description="connectionIntro(words)"
        data-testid="runner-connection"
      >
        <div class="space-y-4">
          <RunnerConnection />
          <p class="border-t border-default pt-4 text-xs text-muted">
            <RunUiText name="runui_connectionHowItWorks">
              <template #run>
                <strong>{{ words.t('runui_requestRun') }}</strong>
              </template>
            </RunUiText>
          </p>
        </div>
      </RunnerSection>
      <RunnerFolders v-else-if="section === 'folders'" />
      <template v-else-if="section === 'general'">
        <RunnerBackgroundSettings />
        <RunnerLanguageSetting />
      </template>
      <RunnerAbout v-else />
    </div>
  </div>
</template>
