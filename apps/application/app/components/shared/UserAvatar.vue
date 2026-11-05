<script setup lang="ts">
/**
 * An account's avatar: the signed-in account's profile picture when it has one
 * (the only picture the instance serves), else the account's initials on a
 * color picked from its id (`#shared/user-avatar`). It sits beside the
 * account's name, so screen readers skip it.
 */
import type { AvatarProps } from '@nuxt/ui';
import { accountInitials, letterAvatarColor } from '#shared/user-avatar';

const props = defineProps<{
  account: { id: number; name: string | null; username: string };
  size?: AvatarProps['size'];
}>();

const config = useRuntimeConfig();
const { authState } = useAuth();
// The picture loads in the browser only, so a failed load shows the initials: a server-rendered image can fail before the page listens.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});

const picture = computed(() => {
  const signedIn = authState.value.user;
  if (!mounted.value || !signedIn?.avatarVersion || signedIn.id !== props.account.id) return undefined;
  return profilePictureSrc(config.app.baseURL, signedIn.avatarVersion);
});
const initials = computed(() => accountInitials(props.account));
const colors = computed(() => {
  const color = letterAvatarColor(props.account.id);
  return {
    '--avatar-bg': color.light.background,
    '--avatar-text': color.light.text,
    '--avatar-bg-dark': color.dark.background,
    '--avatar-text-dark': color.dark.text,
  };
});
</script>

<template>
  <UAvatar
    :src="picture"
    :text="initials ?? undefined"
    :icon="initials ? undefined : 'i-lucide-user'"
    :size="size"
    alt=""
    aria-hidden="true"
    :style="initials ? colors : undefined"
    :ui="
      initials
        ? {
            root: 'bg-(--avatar-bg) dark:bg-(--avatar-bg-dark)',
            fallback: 'text-(--avatar-text) dark:text-(--avatar-text-dark)',
          }
        : undefined
    "
  />
</template>
