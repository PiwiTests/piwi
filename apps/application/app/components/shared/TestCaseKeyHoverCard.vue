<script setup lang="ts">
/**
 * Wraps a tag or an external ID that is a test case key of the project's test management project, and shows the case
 * behind it on hover: its name and status, how Piwi read the key, and when the catalog was read. It reads the stored
 * catalog, never the tool, and only once the card is opened. A key that is not one (tags are not a key source, the tag
 * does not match the pattern, the page shows no one project) leaves the wrapped chip exactly as it was.
 */
import { safeHttpUrl } from '#shared/utils/safe-url';

const props = defineProps<{
  /** Where the key was read from: a test tag, or the test's external ID. */
  kind: 'tag' | 'external-id';
  /** The tag or external ID as the test carries it. */
  value?: string | null;
}>();

const keys = useTestManagementKeys();
const caseKey = computed(() => {
  if (!keys || !props.value) return null;
  return props.kind === 'tag' ? keys.keyForTag(props.value) : keys.keyForExternalId(props.value);
});
const state = computed(() => (caseKey.value ? keys?.state(caseKey.value) : undefined));
const projectKey = computed(() => keys?.projectKey() ?? null);
const url = computed(() => (state.value?.status === 'ready' ? safeHttpUrl(state.value.testCase?.url) : null));

function onOpen(open: boolean): void {
  if (open && caseKey.value) keys?.load(caseKey.value);
}
</script>

<template>
  <UPopover v-if="caseKey" mode="hover" :content="{ side: 'top' }" @update:open="onOpen">
    <slot />
    <template #content>
      <div class="p-3 w-72 max-w-full space-y-1.5 text-sm" data-testid="test-case-key-card">
        <div class="flex items-center gap-1.5">
          <a
            v-if="url"
            :href="url"
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono font-medium text-highlighted hover:underline"
          >
            {{ caseKey }}
          </a>
          <span v-else class="font-mono font-medium text-highlighted">{{ caseKey }}</span>
          <UBadge
            v-if="state?.status === 'ready' && state.testCase"
            color="neutral"
            variant="subtle"
            size="xs"
            data-testid="test-case-key-status"
          >
            {{ state.testCase.status }}
          </UBadge>
        </div>

        <p v-if="!state || state.status === 'loading'" class="text-muted" data-testid="test-case-key-loading">
          Reading the catalog…
        </p>
        <p v-else-if="state.status === 'error'" class="text-muted" data-testid="test-case-key-error">
          Could not look this key up.
        </p>
        <p v-else-if="state.fetchedAt === null" class="text-muted" data-testid="test-case-key-no-catalog">
          Catalog not read yet
        </p>
        <p v-else-if="state.testCase === null" class="text-warning" data-testid="test-case-key-unknown">
          {{ caseKey }} is not a test case in {{ projectKey }}
        </p>
        <template v-else>
          <p class="text-default break-words" data-testid="test-case-key-name">{{ state.testCase.name }}</p>
        </template>

        <p class="text-xs text-muted">
          {{ props.kind === 'tag' ? 'Read from the tag' : 'Read from the external ID' }}
          <template v-if="state?.status === 'ready' && state.fetchedAt">
            · catalog read <ClientDate :date="state.fetchedAt" />
          </template>
        </p>
      </div>
    </template>
  </UPopover>
  <slot v-else />
</template>
