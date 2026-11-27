<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core';
import type { NoticeLevel, OperatorNotice } from '#shared/operator-notice';

/**
 * The notice whoever runs the instance set (`PUT /api/operator/notice`), above every page of the default layout. Read
 * in the server render, so it costs the browser no request. Dismissing it hides that notice in this browser until
 * another replaces it; a critical one stays. Its height is `--operator-notice-height` on the page, which the page
 * panel's minimum height leaves out, so no page runs past the bottom of the window.
 */

const { data } = useFetch<{ notice: OperatorNotice | null }>('/api/notice', {
  key: 'operator-notice',
  dedupe: 'defer',
});

const ONE_YEAR_S = 60 * 60 * 24 * 365;
/** The `setAt` of the notice dismissed in this browser. */
const dismissed = useCookie<string | null>('piwi-notice-dismissed', {
  default: () => null,
  maxAge: ONE_YEAR_S,
  sameSite: 'lax',
});

const notice = computed(() => {
  const current = data.value?.notice ?? null;
  if (!current) return null;
  if (current.level !== 'critical' && dismissed.value === current.setAt) return null;
  return current;
});

/** The host a link leads to, shown beside its label so a label cannot pass for another site. */
const linkHost = computed(() => {
  const url = notice.value?.link?.url;
  return url && URL.canParse(url) ? new URL(url).host : null;
});

const LOOK: Record<NoticeLevel, { color: 'info' | 'warning' | 'error'; icon: string }> = {
  info: { color: 'info', icon: 'i-lucide-info' },
  warning: { color: 'warning', icon: 'i-lucide-triangle-alert' },
  critical: { color: 'error', icon: 'i-lucide-octagon-alert' },
};

const HEIGHT_VARIABLE = '--operator-notice-height';
const bannerEl = useTemplateRef<HTMLElement>('banner');
useResizeObserver(bannerEl, (entries) => {
  const entry = entries[0];
  if (!entry) return;
  const height = (entry.target as HTMLElement).getBoundingClientRect().height;
  document.documentElement.style.setProperty(HEIGHT_VARIABLE, `${height}px`);
});
watch(notice, (shown) => {
  if (!shown && import.meta.client) document.documentElement.style.removeProperty(HEIGHT_VARIABLE);
});
onUnmounted(() => document.documentElement.style.removeProperty(HEIGHT_VARIABLE));

function dismiss() {
  if (!notice.value) return;
  dismissed.value = notice.value.setAt;
  // The close button goes with the banner: the page itself takes the focus.
  document.getElementById('main-content')?.focus();
}
</script>

<template>
  <div v-if="notice" ref="banner" class="shrink-0" data-shot="operator-notice">
    <UAlert
      role="status"
      aria-label="Notice from whoever runs this instance"
      :color="LOOK[notice.level].color"
      :icon="LOOK[notice.level].icon"
      variant="subtle"
      :close="notice.level !== 'critical'"
      :ui="{ description: 'opacity-100' }"
      class="rounded-none"
      @update:open="dismiss"
    >
      <template #description>
        <span class="text-sm text-highlighted leading-relaxed">{{ notice.text }}</span>
        <template v-if="notice.link">
          {{ ' ' }}
          <a
            :href="notice.link.url"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm text-highlighted underline decoration-dotted underline-offset-2 hover:decoration-solid [overflow-wrap:anywhere]"
            >{{ notice.link.label ?? notice.link.url }}</a
          ><span v-if="notice.link.label && linkHost" class="text-xs text-muted"> ({{ linkHost }})</span>
        </template>
      </template>
    </UAlert>
  </div>
</template>
