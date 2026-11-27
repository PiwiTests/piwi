<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core';
import type { NoticeLevel } from '#shared/operator-notice';
import type { ApiResponse } from '~~/types/api';

/**
 * What whoever runs the instance tells its users, above every page of the default layout: the notice they set
 * (`PUT /api/operator/notice`), and, to administrators, the administrators they invited that nobody took yet, in one
 * alert of at most three addresses. Read in the server render, so it costs the browser no request. Dismissing the notice hides it in this browser until another
 * replaces it; a critical one stays, and so does an invitation until it is taken or ends. Their height is
 * `--operator-notice-height` on the page, which the page panel's minimum height leaves out, so no page runs past the
 * bottom of the window.
 */

const { data } = useFetch<ApiResponse<typeof import('~~/server/api/notice.get').default>>('/api/notice', {
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
const invitations = computed(() => data.value?.invitations ?? []);
/** The addresses the invitation alert names: three at most, then how many more. */
const INVITATIONS_NAMED = 3;
const namedInvitations = computed(() => invitations.value.slice(0, INVITATIONS_NAMED));
const moreInvitations = computed(() => Math.max(0, invitations.value.length - INVITATIONS_NAMED));
const shown = computed(() => notice.value !== null || invitations.value.length > 0);

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
watch(shown, (visible) => {
  if (!visible && import.meta.client) document.documentElement.style.removeProperty(HEIGHT_VARIABLE);
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
  <div v-if="shown" ref="banner" class="shrink-0" data-shot="operator-banners">
    <UAlert
      v-if="notice"
      data-shot="operator-notice"
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
    <UAlert
      v-if="invitations.length"
      data-shot="operator-invitation"
      role="status"
      aria-label="Administrators invited by whoever runs this instance"
      color="info"
      icon="i-lucide-user-plus"
      variant="subtle"
      :ui="{ description: 'opacity-100' }"
      class="rounded-none"
    >
      <template #description>
        <span class="text-sm text-highlighted leading-relaxed">
          The operator of this instance invited
          <template v-if="invitations.length === 1">
            <span class="[overflow-wrap:anywhere]">{{ invitations[0]!.email }}</span> as an administrator. If nobody on
            your team expected it, delete the account in
          </template>
          <template v-else>
            {{ invitations.length }} administrators:
            <template v-for="(invitation, index) in namedInvitations" :key="invitation.userId">
              <span class="[overflow-wrap:anywhere]">{{ invitation.email }}</span
              >{{ index < namedInvitations.length - 1 ? ', ' : '' }}
            </template>
            <template v-if="moreInvitations"> and {{ moreInvitations }} more</template>. If nobody on your team expected
            them, delete the accounts in
          </template>
          <NuxtLink to="/settings/users" class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >Settings → Users</NuxtLink
          >.
        </span>
      </template>
    </UAlert>
  </div>
</template>
