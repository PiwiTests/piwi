<script setup lang="ts">
/**
 * The line under a user the operator invited, while nobody took the invitation: until when it holds, or that it ended.
 * Whether it ended is read once the page is in the browser, so the server render and the browser's first render agree.
 */
const props = defineProps<{ invitation: { expiresAt: string | Date } }>();

const now = ref<number | null>(null);
onMounted(() => {
  now.value = Date.now();
});
const ended = computed(() => now.value !== null && new Date(props.invitation.expiresAt).getTime() <= now.value);
</script>

<template>
  <span class="block whitespace-normal text-xs text-muted" data-shot="operator-invitation-mark">
    <template v-if="ended">Invited by the operator; the invitation ended</template>
    <template v-else>Invited by the operator, until <ClientDate :date="invitation.expiresAt" date-only /></template>
  </span>
</template>
