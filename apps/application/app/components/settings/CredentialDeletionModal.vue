<script setup lang="ts">
/**
 * Asks, before a connection or a channel that sends with a credential is
 * deleted, whether to delete that credential too or keep it under Settings →
 * Credentials. The server deletes it only when nothing else names it.
 */
const props = defineProps<{
  /** What is deleted, as the title names it: `Remove the connection`, `Delete the channel`. */
  title: string;
  /** What is deleted, by name. */
  name: string;
  /** The credential's name, when the page knows it. */
  credentialName?: string | null;
  /** The label of what is deleted in the buttons: `Remove`, `Delete`. */
  verb: string;
  loading?: boolean;
}>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ confirm: [deleteCredential: boolean] }>();

const credential = computed(() =>
  props.credentialName ? `the credential “${props.credentialName}”` : 'its credential',
);
</script>

<template>
  <UModal v-model:open="open" :title="title">
    <template #body>
      <p class="text-sm text-highlighted leading-relaxed" data-testid="credential-deletion-question">
        “{{ name }}” sends with {{ credential }}. Delete the credential too, or keep it under Settings → Credentials to
        use elsewhere? It is kept anyway while something else names it.
      </p>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton
          color="neutral"
          variant="outline"
          :label="`${verb}, keep the credential`"
          :loading="loading"
          data-testid="credential-deletion-keep"
          @click="emit('confirm', false)"
        />
        <UButton
          color="error"
          :label="`${verb} and delete the credential`"
          :loading="loading"
          data-testid="credential-deletion-delete"
          @click="emit('confirm', true)"
        />
      </div>
    </template>
  </UModal>
</template>
