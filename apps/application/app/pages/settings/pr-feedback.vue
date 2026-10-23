<script setup lang="ts">
import type { PrFeedbackSettings } from '#shared/pr-feedback';

interface PrFeedbackResponse {
  settings: PrFeedbackSettings;
  defaults: PrFeedbackSettings;
  /** Without PIWI_SITE_URL the links in a comment would point nowhere. */
  siteUrlConfigured: boolean;
}

const toast = useToast();
const { data: response, refresh } = await useFetch<PrFeedbackResponse>('/api/settings/pr-feedback');

const saving = ref(false);
const values = reactive<PrFeedbackSettings>({
  enabled: false,
  comment: true,
  status: true,
  onlyOnFailure: false,
  statusContext: 'piwi/tests',
});

watchEffect(() => {
  if (response.value) Object.assign(values, response.value.settings);
});

const toggles: Array<{ key: 'comment' | 'status' | 'onlyOnFailure'; label: string; description: string }> = [
  {
    key: 'comment',
    label: 'Post a summary comment',
    description:
      'Creates one comment on the pull request and edits it on every later run, so a busy branch gets one comment rather than one per push.',
  },
  {
    key: 'status',
    label: 'Set a commit status',
    description:
      'Marks the run’s commit passed or failed, so the pull request shows the result in its checks list. Still set on a green run when the comment is suppressed.',
  },
  {
    key: 'onlyOnFailure',
    label: 'Only comment on failures',
    description: 'Keeps green runs from adding a comment. The commit status is still set either way.',
  },
];

async function save() {
  saving.value = true;
  try {
    const updated = await $fetch<PrFeedbackResponse>('/api/settings/pr-feedback', {
      method: 'PUT',
      body: { settings: { ...values } },
    });
    response.value = updated;
    Object.assign(values, updated.settings);
    toast.add({ title: 'Saved', color: 'success' });
    await refresh();
  } catch {
    toast.add({ title: 'Save failed', color: 'error' });
  } finally {
    saving.value = false;
  }
}

async function resetToDefaults() {
  saving.value = true;
  try {
    const updated = await $fetch<PrFeedbackResponse>('/api/settings/pr-feedback', {
      method: 'PUT',
      body: { settings: null },
    });
    response.value = updated;
    Object.assign(values, updated.settings);
    toast.add({ title: 'Reset to defaults', color: 'success' });
    await refresh();
  } catch {
    toast.add({ title: 'Reset failed', color: 'error' });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <CapabilityDeclinedGuard capability="pr-feedback" label="Pull-request feedback">
    <div class="space-y-6" data-tour="pr-feedback-page">
      <SectionCard
        icon="i-lucide-git-pull-request"
        title="Pull-request feedback"
        help="settings.pr-feedback"
        data-tour="pr-feedback-settings"
      >
        <template #subtitle>
          When a run finishes on a branch with an open pull request, post the result back to it — new failures separated
          from pre-existing ones, the failure clusters behind them, and the locator to use instead of the one that
          broke.
        </template>

        <UAlert
          v-if="response && !response.siteUrlConfigured"
          color="warning"
          variant="soft"
          icon="i-lucide-triangle-alert"
          title="PIWI_SITE_URL is not set"
          description="Nothing is posted until it is — every link in the comment is built from it, and a comment full of unreachable links is worse than no comment."
          class="mb-4"
        />

        <div class="space-y-4">
          <USwitch v-model="values.enabled" label="Post feedback to pull requests" />

          <div class="space-y-4 pl-1" :class="!values.enabled && 'opacity-50 pointer-events-none'">
            <UFormField
              v-for="toggle in toggles"
              :key="toggle.key"
              :label="toggle.label"
              :description="toggle.description"
            >
              <USwitch v-model="values[toggle.key]" />
            </UFormField>

            <UFormField
              label="Commit status context"
              description="The name shown next to the status in the pull request’s checks list."
              :hint="`default ${response?.defaults.statusContext ?? ''}`"
            >
              <UInput
                v-model="values.statusContext"
                :placeholder="response?.defaults.statusContext"
                class="w-full max-w-sm"
              />
            </UFormField>
          </div>
        </div>

        <template #footer>
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs text-muted">
              Needs an SCM token with write access to the repository — set it globally, or per project in the project’s
              edit page.
            </p>
            <div class="flex items-center gap-2 shrink-0">
              <UButton
                variant="ghost"
                color="neutral"
                :disabled="saving"
                label="Reset to defaults"
                @click="resetToDefaults"
              />
              <UButton color="primary" :loading="saving" icon="i-lucide-save" data-tour="save-pr-feedback" @click="save"
                >Save</UButton
              >
            </div>
          </div>
        </template>
      </SectionCard>
    </div>
  </CapabilityDeclinedGuard>
</template>
