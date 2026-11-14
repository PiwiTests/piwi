<script setup lang="ts">
/**
 * Settings → Source control: the instance-wide SCM token, which every project
 * without its own uses to read its repository (the commits behind a failure,
 * uncovered changes, ownership) and to write to it (pull-request feedback,
 * auto-heal, re-runs in CI). Saved alone through the AI settings endpoint,
 * which stores it apart from the provider configuration.
 */
import type { AiSettings } from '~~/types/api';

const toast = useToast();
const { data: settings, refresh } = await useFetch<AiSettings>('/api/settings/ai');

const token = ref('');
const replacing = ref(false);
const saving = ref(false);
const canStoreSecrets = computed(() => settings.value?.canStoreSecrets ?? true);
const hasToken = computed(() => Boolean(settings.value?.hasScmToken));

/** Saves `value` as the token; null removes the stored one. */
async function store(value: string | null, done: string) {
  saving.value = true;
  try {
    await $fetch('/api/settings/ai', { method: 'PUT', body: { scmToken: value } });
    await refresh();
    token.value = '';
    replacing.value = false;
    toast.add({ title: done, color: 'success' });
  } catch (error) {
    toast.add({ title: 'Could not save the token', description: errorMessage(error), color: 'error' });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UForm :state="{ token }" @submit="store(token.trim(), 'SCM token saved')">
    <SectionCard
      icon="i-lucide-git-branch"
      title="Repository access"
      subtitle="The GitHub, GitLab or Bitbucket token every project without its own reads and writes its repository with."
      data-tour="source-control-token"
      data-shot="source-control-token"
    >
      <SettingsField
        label="SCM token"
        help="project.scm-token"
        description="Read access lets diagnosis, What changed and uncovered changes read commits and diffs; pull-request feedback, auto-heal and re-runs in CI need write access. A public repository needs none for reading, and a project's own token, set in its Source control settings, takes precedence."
      >
        <p v-if="!canStoreSecrets" class="text-sm text-muted">
          Needs <code class="font-mono text-xs">PIWI_SECRET_KEY</code> on the server to be stored.
        </p>
        <div v-else-if="hasToken && !replacing" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="text-sm text-highlighted">A token is stored, encrypted.</span>
          <UButton color="neutral" variant="link" size="sm" class="px-0" @click="replacing = true">Replace</UButton>
          <UButton
            color="neutral"
            variant="link"
            size="sm"
            class="px-0"
            :disabled="saving"
            @click="store(null, 'SCM token removed')"
            >Remove</UButton
          >
        </div>
        <UInput
          v-else
          v-model="token"
          type="password"
          name="scmToken"
          placeholder="ghp_…, glpat-… or a Bitbucket token"
          autocomplete="off"
          aria-label="SCM token"
          class="w-full font-mono sm:max-w-md"
        />
      </SettingsField>

      <template v-if="canStoreSecrets && (!hasToken || replacing)" #footer>
        <div class="flex justify-end gap-2">
          <UButton v-if="replacing" color="neutral" variant="ghost" @click="replacing = false">Cancel</UButton>
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!token.trim()">Save</UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>
