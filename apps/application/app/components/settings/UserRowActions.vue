<script setup lang="ts">
/**
 * The per-user actions of Settings → Users, shared by the table and the phone
 * card list: send an invite, edit the user's project roles, manage their API
 * keys, remove their uploaded profile picture, delete them. The page owns what
 * each one does.
 */
import { InstanceRole } from '#shared/permissions';
import type { UserListItem } from '#shared/project-access';

defineProps<{
  user: UserListItem;
  /** Whether the viewer manages users (invites, project roles, deletion). */
  canManage: boolean;
  /** Whether the viewer may manage this user's API keys (their own, or anyone's for an administrator). */
  canManageKeys: boolean;
  inviting?: boolean;
  removingPicture?: boolean;
}>();

const emit = defineEmits<{
  invite: [];
  'project-roles': [];
  'api-keys': [];
  'remove-picture': [];
  delete: [];
}>();
</script>

<template>
  <div class="flex items-center justify-end gap-1">
    <UButton
      v-if="canManage && user.email && !user.oauthProvider"
      icon="i-lucide-send"
      color="neutral"
      variant="ghost"
      size="sm"
      title="Send invite email"
      aria-label="Send invite email"
      :loading="inviting"
      @click="emit('invite')"
    />
    <UButton
      v-if="canManage && user.instanceRole !== InstanceRole.ADMINISTRATOR"
      icon="i-lucide-folder-lock"
      color="neutral"
      variant="ghost"
      size="sm"
      title="Project roles"
      :aria-label="`Project roles of ${user.username}`"
      @click="emit('project-roles')"
    />
    <UButton
      v-if="canManageKeys"
      icon="i-lucide-key"
      color="neutral"
      variant="ghost"
      size="sm"
      title="Manage API keys"
      aria-label="Manage API keys"
      @click="emit('api-keys')"
    />
    <UButton
      v-if="canManage && user.avatarUploaded"
      icon="i-lucide-image-off"
      color="neutral"
      variant="ghost"
      size="sm"
      title="Remove profile picture"
      :aria-label="`Remove the profile picture of ${user.username}`"
      :loading="removingPicture"
      @click="emit('remove-picture')"
    />
    <UButton
      v-if="canManage"
      icon="i-lucide-trash-2"
      color="error"
      variant="ghost"
      size="sm"
      title="Delete user"
      :aria-label="`Delete ${user.username}`"
      @click="emit('delete')"
    />
  </div>
</template>
