<script setup lang="ts">
import type { EntityLinkInfo } from '~~/types/api';
import { detectProvider, getProviderIcon } from '#shared/link-detect';
import type { LinkEntityType } from '#shared/handlers/links';

const props = defineProps<{
  entityType: LinkEntityType;
  entityId: number;
  links?: EntityLinkInfo[] | null;
  /** Hide the add/remove controls for viewers without write access. */
  readonly?: boolean;
}>();

const emit = defineEmits<{
  updated: [];
}>();

const toast = useToast();

const localLinks = ref<EntityLinkInfo[]>(props.links ?? []);
const newUrl = ref('');
const addLinkOpen = ref(false);
const adding = ref(false);

const previewProvider = computed(() => {
  try {
    return newUrl.value ? detectProvider(newUrl.value) : null;
  } catch {
    return null;
  }
});

const previewIcon = computed(() => {
  return previewProvider.value ? getProviderIcon(previewProvider.value as any) : null;
});

// The server takes a full http(s) URL; a bare key ("PROJ-12") is caught here
// with a hint rather than refused after Add.
const isUrl = computed(() => /^https?:\/\/\S+$/i.test(newUrl.value.trim()));
const showUrlHint = computed(() => newUrl.value.trim().length > 0 && !isUrl.value);

async function loadLinks() {
  const data = await $fetch<{ items: EntityLinkInfo[] }>('/api/links', {
    params: { entityType: props.entityType, entityId: props.entityId },
  });
  localLinks.value = data.items;
}

async function addLink() {
  if (!isUrl.value || adding.value) return;
  adding.value = true;
  try {
    const data = await $fetch<{ link: EntityLinkInfo }>('/api/links', {
      method: 'POST',
      body: { entityType: props.entityType, entityId: props.entityId, url: newUrl.value.trim() },
    });
    localLinks.value.push(data.link);
    newUrl.value = '';
    addLinkOpen.value = false;
    toast.add({ title: data.link.key ? `Linked ${data.link.key}` : 'Link added', color: 'success' });
    emit('updated');
  } catch (e) {
    toast.add({ title: 'Could not add the link', description: errorMessage(e), color: 'error' });
  } finally {
    adding.value = false;
  }
}

function unlinkWarning(link: EntityLinkInfo): string {
  if (link.provider === 'zephyr-scale') {
    return `Unlink ${link.key ?? 'this test run'}? Piwi sent this run's results to it. The test run itself stays in the test management tool.`;
  }
  return `Unlink ${link.key ?? 'this issue'}? Piwi filed it: unlinking stops its status sync and the comments Piwi writes to it. The issue itself stays in the tracker.`;
}

async function removeLink(id: number) {
  // An issue Piwi filed is synced and written to through its link: say so first.
  const link = localLinks.value.find((l) => l.id === id);
  if (link?.origin === 'created' && !window.confirm(unlinkWarning(link))) return;
  try {
    await $fetch(`/api/links/${id}`, { method: 'DELETE' });
    localLinks.value = localLinks.value.filter((l) => l.id !== id);
    emit('updated');
  } catch (e) {
    toast.add({ title: 'Could not remove the link', description: errorMessage(e), color: 'error' });
  }
}

watch(
  () => [props.entityType, props.entityId] as const,
  () => {
    if (props.links) {
      localLinks.value = props.links;
    } else {
      loadLinks();
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5">
    <LinkChip v-for="link in localLinks" :key="link.id" :link="link" :removable="!readonly" @remove="removeLink" />

    <span v-if="readonly && localLinks.length === 0" class="text-xs text-muted">None</span>

    <UPopover v-if="!readonly" v-model:open="addLinkOpen">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-plus"
        class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        title="Add link"
      />

      <template #content>
        <form class="p-3 space-y-3 min-w-72" method="post" @submit.prevent="addLink">
          <p class="text-sm font-medium">Add link</p>

          <div class="relative">
            <UInput v-model="newUrl" placeholder="https://..." size="sm" class="w-full" autofocus />
            <UIcon
              v-if="previewIcon"
              :name="previewIcon!"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            />
          </div>

          <p v-if="showUrlHint" class="text-xs text-muted" data-testid="link-url-hint">
            Paste the full URL, for example https://acme.atlassian.net/browse/PROJ-12.
          </p>

          <div class="flex justify-end gap-2">
            <UButton size="xs" variant="ghost" color="neutral" @click="addLinkOpen = false"> Cancel </UButton>
            <UButton size="xs" color="primary" type="submit" :loading="adding" :disabled="!isUrl"> Add </UButton>
          </div>
        </form>
      </template>
    </UPopover>
  </div>
</template>
