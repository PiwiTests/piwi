<script setup lang="ts">
/**
 * `/settings` has no content of its own — it redirects to the first settings
 * page the current user can actually see.
 *
 * The target is computed from the same nav registry rather than hardcoded,
 * because "the first page" differs by role and build: a web instance lands on
 * Account (admin or not), while the desktop build — single-user, auth off,
 * account pages hidden — lands on Desktop app.
 *
 * The redirect is issued synchronously in setup so it also happens during SSR
 * (a real redirect response rather than a flash of this page). `useSettingsNav`
 * is a pure computed over the static registry plus auth state, so reading it
 * here needs no await. The template is only what a client sees in the gap
 * before navigation commits.
 */
const navItems = await useSettingsNav();

// `replace` so Back returns to wherever the user came from rather than bouncing
// them through this redirect again.
const firstPage = navItems.value.flat().find((item) => typeof item.to === 'string')?.to as string | undefined;
if (firstPage) {
  await navigateTo(firstPage, { replace: true });
}
</script>

<template>
  <LoadingState text="Opening settings…" />
</template>
