<script setup lang="ts">
/**
 * The buttons of the assistant panel's header: the user's conversations, a
 * new conversation and, from 1280 px up, docking the panel beside the page
 * or floating it over the page.
 */
const { available, busy, view, showList, startNewConversation } = useAssistant();
const { wide, docked, floating } = useAssistantDock();
</script>

<template>
  <div class="flex items-center gap-1">
    <template v-if="available">
      <UButton
        icon="i-lucide-history"
        color="neutral"
        variant="ghost"
        :aria-label="view === 'list' ? 'Back to the conversation' : 'Conversations'"
        :title="view === 'list' ? 'Back to the conversation' : 'Conversations'"
        :aria-pressed="view === 'list'"
        data-tour="assistant-conversations-button"
        @click="view === 'list' ? (view = 'conversation') : showList()"
      />
      <UButton
        icon="i-lucide-square-pen"
        color="neutral"
        variant="ghost"
        aria-label="New conversation"
        title="New conversation"
        :disabled="busy"
        @click="startNewConversation()"
      />
    </template>
    <UButton
      v-if="wide"
      :icon="docked ? 'i-lucide-panel-right-dashed' : 'i-lucide-panel-right'"
      color="neutral"
      variant="ghost"
      :aria-label="docked ? 'Float over the page' : 'Dock beside the page'"
      :title="docked ? 'Float over the page' : 'Dock beside the page'"
      data-assistant-dock
      @click="floating = !floating"
    />
  </div>
</template>
