<script setup lang="ts">
import type { AutoHealSettings } from '#shared/auto-heal';

interface AutoHealResponse {
  settings: AutoHealSettings;
  defaults: AutoHealSettings;
  /** Without PIWI_SITE_URL the links in the PR body would point nowhere. */
  siteUrlConfigured: boolean;
}

interface ProjectMenuItem {
  id: number;
  name: string;
  label: string | null;
}

const toast = useToast();
const { data: response, refresh } = await useFetch<AutoHealResponse>('/api/settings/auto-heal');
const { data: projectsMenu } = await useFetch('/api/projects/menu', {
  default: () => [] as ProjectMenuItem[],
  transform: (r: { items: ProjectMenuItem[] }) => r.items,
});

const projectItems = computed(() => (projectsMenu.value ?? []).map((p) => ({ label: p.label || p.name, value: p.id })));

const saving = ref(false);
const values = reactive<AutoHealSettings>({
  enabled: false,
  projects: [],
  minScore: 80,
  draft: true,
  maxOpenPrs: 3,
  branchPrefix: 'piwi/heal/',
  commitMessage: 'test: heal broken locators',
});

watchEffect(() => {
  if (response.value) Object.assign(values, response.value.settings);
});

async function persist(body: { settings: AutoHealSettings | null }, okTitle: string) {
  saving.value = true;
  try {
    const updated = await $fetch<AutoHealResponse>('/api/settings/auto-heal', { method: 'PUT', body });
    response.value = updated;
    Object.assign(values, updated.settings);
    toast.add({ title: okTitle, color: 'success' });
    await refresh();
  } catch {
    toast.add({ title: 'Save failed', color: 'error' });
  } finally {
    saving.value = false;
  }
}

const save = () => persist({ settings: { ...values, projects: [...values.projects] } }, 'Saved');
const resetToDefaults = () => persist({ settings: null }, 'Reset to defaults');
</script>

<template>
  <CapabilityDeclinedGuard capability="auto-heal" label="Auto-heal">
    <div class="space-y-6" data-tour="auto-heal-page">
      <SectionCard
        icon="i-lucide-bandage"
        title="Auto-heal pull requests"
        help="settings.auto-heal"
        data-tour="auto-heal-settings"
      >
        <template #subtitle>
          When a locator breaks on the default branch and healing has a high-confidence replacement, Piwi opens the fix
          pull request itself — a deterministic one-line locator edit per broken call site. No AI-generated code is ever
          in the write path.
        </template>

        <UAlert
          v-if="response && !response.siteUrlConfigured"
          color="warning"
          variant="soft"
          icon="i-lucide-triangle-alert"
          title="PIWI_SITE_URL is not set"
          description="Nothing is opened until it is — the links in the PR body are built from it."
          class="mb-4"
        />

        <div class="space-y-4">
          <USwitch v-model="values.enabled" label="Open pull requests to heal broken locators" />

          <div class="space-y-4 pl-1" :class="!values.enabled && 'opacity-50 pointer-events-none'">
            <UFormField
              label="Projects"
              description="Auto-heal only acts on the projects you list here — it never touches a project that isn’t selected."
            >
              <USelectMenu
                v-model="values.projects"
                :items="projectItems"
                value-key="value"
                multiple
                placeholder="Select projects…"
                class="w-full max-w-md"
              />
            </UFormField>

            <UFormField
              label="Minimum score"
              description="The stability score (0–100) a replacement needs before it opens a PR. A locator you confirmed in the picker is always eligible."
              :hint="`default ${response?.defaults.minScore ?? 80}`"
            >
              <UInput v-model.number="values.minScore" type="number" min="0" max="100" class="w-28" />
            </UFormField>

            <UFormField
              label="Open as draft"
              description="Open the PR as a draft. Ignored on Bitbucket, which has no draft pull requests."
            >
              <USwitch v-model="values.draft" />
            </UFormField>

            <UFormField
              label="Max open PRs per project"
              description="A ceiling on how many auto-heal PRs can still be open on your repository at once for one project. Merged and closed PRs stop counting."
              :hint="`default ${response?.defaults.maxOpenPrs ?? 3}`"
            >
              <UInput v-model.number="values.maxOpenPrs" type="number" min="0" max="50" class="w-28" />
            </UFormField>

            <UFormField
              label="Branch prefix"
              description="The branch namespace auto-heal pushes to. Runs reported from a branch under this prefix never trigger another heal."
              :hint="`default ${response?.defaults.branchPrefix ?? ''}`"
            >
              <UInput
                v-model="values.branchPrefix"
                :placeholder="response?.defaults.branchPrefix"
                class="w-full max-w-xs"
              />
            </UFormField>

            <UFormField
              label="Commit message"
              description="The commit subject (and PR title). Keep it a conventional-commit subject so your commit lint accepts it."
              :hint="`default ${response?.defaults.commitMessage ?? ''}`"
            >
              <UInput
                v-model="values.commitMessage"
                :placeholder="response?.defaults.commitMessage"
                class="w-full max-w-md"
              />
            </UFormField>
          </div>
        </div>

        <template #footer>
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs text-muted">
              Needs an SCM token with write access. Prefer a per-project token — the global one grants write everywhere
              it reaches.
            </p>
            <div class="flex items-center gap-2 shrink-0">
              <UButton
                variant="ghost"
                color="neutral"
                :disabled="saving"
                label="Reset to defaults"
                @click="resetToDefaults"
              />
              <UButton color="primary" :loading="saving" icon="i-lucide-save" data-tour="save-auto-heal" @click="save"
                >Save</UButton
              >
            </div>
          </div>
        </template>
      </SectionCard>
    </div>
  </CapabilityDeclinedGuard>
</template>
