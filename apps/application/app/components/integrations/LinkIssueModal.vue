<script setup lang="ts">
/**
 * Link an existing ticket to a failure cluster by its URL. The link becomes the
 * cluster's known issue when it is a tracker issue (a Jira key, or a link on a
 * connected tracker), so it shows on the cluster page and on every execution of
 * the cluster. On a cluster that already has an issue, the description says
 * that issue stays linked and a tracker issue linked now takes its place. A bare
 * key is caught before the request with a hint, since the link needs the
 * issue's full URL.
 */
const props = defineProps<{
  clusterId: number;
  /** The cluster's issue, when it has one. */
  knownIssueKey?: string | null;
}>();

const description = computed(() =>
  props.knownIssueKey
    ? `${props.knownIssueKey} stays linked. The cluster's issue is its newest linked Jira issue, or issue on a connected tracker: link one and it takes ${props.knownIssueKey}'s place on the cluster page and on each of its executions.`
    : 'The issue then tracks every failure of the cluster: it shows on the cluster page and on each of its executions.',
);

const open = defineModel<boolean>('open', { default: false });

const emit = defineEmits<{ linked: [] }>();

const toast = useToast();
const url = ref('');
const linking = ref(false);

const isUrl = computed(() => /^https?:\/\/\S+$/i.test(url.value.trim()));
const showUrlHint = computed(() => url.value.trim().length > 0 && !isUrl.value);

watch(open, (isOpen) => {
  if (isOpen) url.value = '';
});

async function link() {
  if (!isUrl.value || linking.value) return;
  linking.value = true;
  try {
    const data = await $fetch<{ link: { key: string | null } }>('/api/links', {
      method: 'POST',
      body: { entityType: 'failure_cluster', entityId: props.clusterId, url: url.value.trim() },
    });
    const what = data.link.key ?? 'The issue';
    toast.add({ title: `${what} linked to cluster #${props.clusterId}`, color: 'success' });
    open.value = false;
    emit('linked');
  } catch (e) {
    toast.add({ title: 'Could not link the issue', description: errorMessage(e), color: 'error' });
  } finally {
    linking.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="`Link an issue to cluster #${clusterId}`" :description="description">
    <template #body>
      <form class="space-y-2" method="post" @submit.prevent="link">
        <UFormField label="Issue URL">
          <UInput
            v-model="url"
            placeholder="https://acme.atlassian.net/browse/PROJ-12"
            class="w-full"
            autofocus
            data-testid="link-issue-url"
          />
        </UFormField>
        <p v-if="showUrlHint" class="text-xs text-muted">Paste the issue's full URL, not only its key.</p>
      </form>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" @click="open = false">Cancel</UButton>
        <UButton :loading="linking" :disabled="!isUrl" @click="link">Link</UButton>
      </div>
    </template>
  </UModal>
</template>
