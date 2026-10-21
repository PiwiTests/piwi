<script setup lang="ts">
/**
 * Desktop shell only: back/forward history buttons, joined as one control the
 * way a native toolbar pairs them. The webview has no browser chrome, so this
 * is the visible counterpart of the mouse-button and trackpad-swipe navigation
 * the webview already supports. Sits beside the logo at the top of the
 * sidebar; in the collapsed rail it stacks vertically like every other rail
 * control. Renders nothing in a plain browser, which has its own chrome.
 */
defineProps<{ collapsed?: boolean }>();

const isDesktop = useIsDesktop();
const { canGoBack, canGoForward, goBack, goForward } = useDesktopHistoryNav();
</script>

<template>
  <UFieldGroup v-if="isDesktop" :orientation="collapsed ? 'vertical' : 'horizontal'" class="shrink-0">
    <UButton
      icon="i-lucide-chevron-left"
      color="neutral"
      variant="ghost"
      size="sm"
      square
      :disabled="!canGoBack"
      aria-label="Back"
      title="Back"
      @click="goBack"
    />
    <UButton
      icon="i-lucide-chevron-right"
      color="neutral"
      variant="ghost"
      size="sm"
      square
      :disabled="!canGoForward"
      aria-label="Forward"
      title="Forward"
      @click="goForward"
    />
  </UFieldGroup>
</template>
