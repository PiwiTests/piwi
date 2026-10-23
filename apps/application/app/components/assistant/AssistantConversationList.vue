<script setup lang="ts">
/** The user's conversations, the most recently active first: open one, start another, delete one. */
const {
  conversations,
  conversationsError,
  conversation,
  busy,
  loadConversations,
  openConversation,
  deleteConversation,
} = useAssistant();
</script>

<template>
  <div class="space-y-2" data-assistant-conversations>
    <p class="text-sm font-semibold text-highlighted">Your conversations</p>
    <ErrorState v-if="conversationsError" :text="conversationsError">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" label="Try again" @click="loadConversations()" />
      </template>
    </ErrorState>
    <LoadingState v-else-if="conversations === null" />
    <EmptyState v-else-if="conversations.length === 0" text="No conversations yet." />
    <ul v-else class="divide-y divide-default">
      <li v-for="item in conversations" :key="item.id" class="flex items-center gap-2 py-1.5">
        <button
          type="button"
          class="min-w-0 flex-1 rounded px-1 py-1 text-left hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
          :disabled="busy"
          :aria-current="conversation?.id === item.id || undefined"
          @click="openConversation(item.id)"
        >
          <span class="block truncate text-sm text-highlighted">{{ item.title || 'Untitled conversation' }}</span>
          <span class="block text-xs text-muted">
            <ClientOnly>{{ formatRelativeTime(item.updatedAt) }}</ClientOnly>
          </span>
        </button>
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          icon="i-lucide-trash-2"
          :aria-label="`Delete ${item.title || 'conversation'}`"
          title="Delete"
          :disabled="busy && conversation?.id === item.id"
          @click="deleteConversation(item.id)"
        />
      </li>
    </ul>
  </div>
</template>
