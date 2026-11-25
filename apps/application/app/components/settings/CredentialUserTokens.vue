<script setup lang="ts">
/**
 * The people who gave their own token for a per-user credential, as its
 * managers see them: who, their account on the CI server, the token's state
 * and dates, never the token. **Remove** takes one person's out of Piwi,
 * **Remove all** everyone's, so each gives theirs again.
 */
import type { UserTokenView } from '#shared/credentials';
import type { ApiResponse } from '~~/types/api';

type TokensAnswer = ApiResponse<typeof import('~~/server/api/credentials/[id]/tokens/index.get').default>;

const props = defineProps<{ credentialId: number }>();
const emit = defineEmits<{ changed: [] }>();

const toast = useToast();
const tokens = ref<UserTokenView[]>([]);
/** Whether **Remove all** waits for its confirmation. */
const confirmingAll = ref(false);

async function load() {
  try {
    tokens.value = (await $fetch<TokensAnswer>(`/api/credentials/${props.credentialId}/tokens`)).items;
  } catch {
    tokens.value = [];
  }
}
watch(() => props.credentialId, load, { immediate: true });

async function remove(userId: number | null) {
  confirmingAll.value = false;
  try {
    await $fetch(`/api/credentials/${props.credentialId}/tokens${userId == null ? '' : `/${userId}`}`, {
      method: 'DELETE',
    });
    toast.add({ title: userId == null ? 'Every token removed' : 'Token removed', color: 'success' });
    await load();
    emit('changed');
  } catch (e) {
    toast.add({ title: 'The token could not be removed', description: errorMessage(e), color: 'error' });
  }
}
</script>

<template>
  <div class="space-y-2" data-testid="credential-user-tokens">
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm font-semibold text-highlighted">
        People who gave their token<span v-if="tokens.length" class="font-normal text-muted">
          · {{ tokens.length }}</span
        >
      </p>
      <UButton
        v-if="tokens.length > 1"
        size="xs"
        color="neutral"
        variant="ghost"
        label="Remove all"
        data-testid="credential-user-tokens-remove-all"
        @click="confirmingAll = true"
      />
    </div>
    <p v-if="tokens.length === 0" class="text-sm text-muted">
      Nobody yet. Each person gives theirs from their account, or from the run dialog when they first start an action on
      it.
    </p>
    <ul v-else class="divide-y divide-default rounded-md border border-default">
      <li
        v-for="token in tokens"
        :key="token.userId"
        class="flex items-center gap-3 px-3 py-2"
        :data-testid="`credential-user-token-${token.userId}`"
      >
        <div class="min-w-0 flex-1 space-y-0.5">
          <div class="flex items-center gap-2">
            <span class="truncate text-sm text-highlighted">{{ token.userName }}</span>
            <UBadge
              v-if="token.state === 'invalid'"
              color="error"
              variant="soft"
              size="xs"
              class="shrink-0"
              label="Refused"
            />
          </div>
          <p class="truncate text-xs text-muted">
            <span class="font-mono">{{ token.remoteUser }}</span> ·
            <template v-if="token.state === 'invalid'">refused by the CI server</template>
            <ClientOnly v-else-if="token.lastUsedAt">
              <span :title="prettyDateFormat(token.lastUsedAt)">used {{ formatRelativeTime(token.lastUsedAt) }}</span>
            </ClientOnly>
            <template v-else>never used</template>
          </p>
        </div>
        <UTooltip text="Remove from Piwi">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-trash-2"
            :aria-label="`Remove the token of ${token.userName}`"
            class="shrink-0"
            @click="remove(token.userId)"
          />
        </UTooltip>
      </li>
    </ul>
    <UModal
      v-model:open="confirmingAll"
      title="Remove every token?"
      :description="`The ${tokens.length} people who gave their token give it again before an action on this credential runs in their name. Their tokens stay valid on the CI server.`"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="outline" label="Cancel" @click="confirmingAll = false" />
          <UButton color="error" label="Remove every token" icon="i-lucide-trash-2" @click="remove(null)" />
        </div>
      </template>
    </UModal>
  </div>
</template>
