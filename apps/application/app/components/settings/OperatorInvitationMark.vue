<script setup lang="ts">
/** The line under a user the operator invited, while nobody took the invitation: until when it holds, or that it ended. */
const props = defineProps<{ invitation: { invitedAt: string | Date; expiresAt: string | Date } }>();

const ended = computed(() => new Date(props.invitation.expiresAt).getTime() <= Date.now());
</script>

<template>
  <span class="block whitespace-normal text-xs text-muted" data-shot="operator-invitation-mark">
    <template v-if="ended">Invited by the operator; the invitation ended</template>
    <template v-else>Invited by the operator, until <ClientDate :date="invitation.expiresAt" date-only /></template>
  </span>
</template>
