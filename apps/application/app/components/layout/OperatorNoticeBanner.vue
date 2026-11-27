<script setup lang="ts">
import type { NoticeLevel, OperatorNotice } from '#shared/operator-notice';

/**
 * The notice whoever runs the instance set (`PUT /api/operator/notice`), above every page of the signed-in app. Read
 * in the server render, so it costs the browser no request. Dismissing it hides that notice in this browser until
 * another replaces it; a critical one stays.
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

const LOOK: Record<NoticeLevel, { color: 'info' | 'warning' | 'error'; icon: string }> = {
  info: { color: 'info', icon: 'i-lucide-info' },
  warning: { color: 'warning', icon: 'i-lucide-triangle-alert' },
  critical: { color: 'error', icon: 'i-lucide-octagon-alert' },
};

function dismiss() {
  if (notice.value) dismissed.value = notice.value.setAt;
}
</script>

<template>
  <UAlert
    v-if="notice"
    data-shot="operator-notice"
    role="status"
    aria-label="Notice from whoever runs this instance"
    :color="LOOK[notice.level].color"
    :icon="LOOK[notice.level].icon"
    variant="subtle"
    :close="notice.level !== 'critical' ? { 'aria-label': 'Dismiss this notice' } : false"
    class="shrink-0 rounded-none border-x-0 border-t-0"
    @update:open="dismiss"
  >
    <template #description>
      <span class="text-sm leading-relaxed">{{ notice.text }}</span>
      <template v-if="notice.link">
        {{ ' ' }}
        <a
          :href="notice.link.url"
          target="_blank"
          rel="noopener noreferrer"
          class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >{{ notice.link.label ?? notice.link.url }}</a
        >
      </template>
    </template>
  </UAlert>
</template>
