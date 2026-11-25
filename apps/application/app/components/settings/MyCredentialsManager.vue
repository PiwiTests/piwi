<script setup lang="ts">
/**
 * The per-user credentials a person may use, each with their own token's
 * state: **Give token** (or give it again), **Test**, **Remove**. An action on
 * one runs in their name on the CI server, with their rights. A token they
 * hold for a credential they can no longer use stays listed, so they can
 * remove it.
 */
import type { MyCredentialEntry } from '#shared/credentials';
import type { ApiResponse } from '~~/types/api';

type MineAnswer = ApiResponse<typeof import('~~/server/api/credentials/mine.get').default>;
type TestAnswer = ApiResponse<typeof import('~~/server/api/credentials/[id]/token/test.post').default>;

const toast = useToast();
const { data, refresh, status } = useFetch<MineAnswer>('/api/credentials/mine', { server: false });
const entries = computed(() => (data.value?.items ?? []) as MyCredentialEntry[]);
/** The credential whose token form is open. */
const giving = ref<number | null>(null);
const busy = ref<number | null>(null);

async function saved() {
  giving.value = null;
  toast.add({ title: 'Token saved', color: 'success' });
  await refresh();
}

async function test(entry: MyCredentialEntry) {
  busy.value = entry.id;
  try {
    const answer = await $fetch<TestAnswer>(`/api/credentials/${entry.id}/token/test`, { method: 'POST' });
    toast.add(
      answer.ok
        ? { title: 'The CI server took your token', color: 'success' }
        : { title: 'Your token was not taken', description: answer.message ?? undefined, color: 'error' },
    );
    await refresh();
  } catch (e) {
    toast.add({ title: 'The token could not be tested', description: errorMessage(e), color: 'error' });
  } finally {
    busy.value = null;
  }
}

async function remove(entry: MyCredentialEntry) {
  busy.value = entry.id;
  try {
    await $fetch(`/api/credentials/${entry.id}/token`, { method: 'DELETE' });
    toast.add({
      title: 'Token removed from Piwi',
      description: 'It stays valid on the CI server: revoke it there too.',
      color: 'success',
    });
    await refresh();
  } catch (e) {
    toast.add({ title: 'The token could not be removed', description: errorMessage(e), color: 'error' });
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="space-y-3" data-testid="my-credentials">
    <p class="text-sm text-muted">
      Credentials that run CI actions in your name, with your own token, so the CI server shows who started each build
      and applies your rights.
    </p>
    <p v-if="status === 'error'" class="text-sm text-error">Your credentials could not be read: reload the page.</p>
    <p v-else-if="status !== 'success'" class="text-sm text-muted">Reading your credentials…</p>
    <EmptyState v-else-if="entries.length === 0" icon="i-lucide-key-round" text="No credential asks for your token." />
    <ul v-else class="divide-y divide-default rounded-md border border-default">
      <li
        v-for="entry in entries"
        :key="entry.id"
        class="px-3 py-2 space-y-2"
        :data-testid="`my-credential-${entry.id}`"
      >
        <div class="flex items-center gap-3">
          <div class="min-w-0 flex-1 space-y-0.5">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm text-highlighted">{{ entry.name }}</span>
              <UBadge
                v-if="entry.token?.state === 'invalid'"
                color="error"
                variant="soft"
                size="xs"
                class="shrink-0"
                label="Refused"
              />
            </div>
            <p class="truncate text-xs text-muted font-mono">{{ entry.destination }}</p>
            <p class="text-xs text-muted" data-testid="my-credential-state">
              <template v-if="!entry.token">Its actions are refused to you until you give your token.</template>
              <template v-else-if="entry.token.state === 'invalid'"
                >The CI server refused your token: give it again.</template
              >
              <template v-else>
                As <span class="font-mono">{{ entry.token.remoteUser }}</span
                >, tested
                <ClientOnly>
                  <span :title="prettyDateFormat(entry.token.testedAt)">{{
                    formatRelativeTime(entry.token.testedAt)
                  }}</span>
                </ClientOnly>
              </template>
              <template v-if="entry.disabled"> · Disabled by an administrator</template>
              <template v-if="!entry.usable"> · No project you run CI on uses it</template>
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <UButton
              v-if="entry.usable && !entry.disabled"
              size="xs"
              color="neutral"
              variant="outline"
              :label="entry.token ? 'Give again' : 'Give token'"
              data-testid="my-credential-give"
              @click="giving = giving === entry.id ? null : entry.id"
            />
            <UTooltip v-if="entry.token" text="Test with the CI server">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-plug-zap"
                aria-label="Test your token"
                :loading="busy === entry.id"
                data-testid="my-credential-test"
                @click="test(entry)"
              />
            </UTooltip>
            <UTooltip v-if="entry.token" text="Remove from Piwi">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-trash-2"
                aria-label="Remove your token"
                :disabled="busy === entry.id"
                data-testid="my-credential-remove"
                @click="remove(entry)"
              />
            </UTooltip>
          </div>
        </div>
        <UserTokenForm v-if="giving === entry.id" :credential-id="entry.id" :entry="entry" @saved="saved" />
      </li>
    </ul>
  </div>
</template>
