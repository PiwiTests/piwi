<script setup lang="ts">
import type { OpenApiSpec } from '~/utils/openapi';
import { foldText } from '#shared/utils/fold-text';

const props = defineProps<{
  spec: OpenApiSpec;
  specUrl: string;
}>();

const { copy, copied } = useCopy();
const { isDesktop, download } = useDesktopDownload();

const query = ref('');

// In the desktop shell a `target="_blank"` link is inert, so save the spec to
// disk instead of trying (and failing) to open it in a new window.
function onSpecClick(event: MouseEvent) {
  if (!isDesktop) return;
  event.preventDefault();
  download(props.specUrl, 'piwi-openapi.json');
}

const groups = computed(() => groupOperationsByTag(props.spec));

const operationCount = computed(() => groups.value.reduce((sum, group) => sum + group.operations.length, 0));

const filteredGroups = computed(() => {
  const needle = foldText(query.value.trim());
  if (!needle) return groups.value;
  return groups.value
    .map((group) => ({
      tag: group.tag,
      operations: group.operations.filter((op) => {
        const haystack = `${op.method} ${op.path} ${op.operation.summary ?? ''} ${op.operation.description ?? ''} ${op.tag}`;
        return foldText(haystack).includes(needle);
      }),
    }))
    .filter((group) => group.operations.length > 0);
});

const baseUrl = computed(() => props.spec.servers?.[0]?.url ?? '');

function tagAnchor(tag: string): string {
  return `tag-${tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}`;
}
</script>

<template>
  <div class="space-y-6 max-sm:px-4">
    <!-- Overview -->
    <header class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-xl font-semibold text-highlighted">{{ spec.info?.title ?? 'API Reference' }}</h1>
        <UBadge v-if="spec.info?.version" color="neutral" variant="subtle" class="font-mono">
          v{{ spec.info.version }}
        </UBadge>
      </div>
      <p v-if="spec.info?.description" class="text-sm text-muted">{{ spec.info.description }}</p>

      <div v-if="baseUrl" class="flex items-center gap-2 text-sm">
        <span class="text-dimmed">Base URL</span>
        <UButton
          :label="baseUrl"
          color="neutral"
          variant="subtle"
          size="xs"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          class="font-mono"
          @click="copy(baseUrl, { toast: true })"
        />
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <UButton
          :to="specUrl"
          target="_blank"
          external
          color="neutral"
          variant="outline"
          size="xs"
          icon="i-lucide-file-json"
          label="Raw OpenAPI spec"
          @click="onSpecClick"
        />
        <span class="text-xs text-dimmed">{{ operationCount }} endpoints</span>
      </div>

      <UAlert
        color="info"
        variant="subtle"
        icon="i-lucide-terminal"
        title="Windows users"
        description="curl examples below use Unix syntax — run them in Git Bash / WSL, or use PowerShell's Invoke-RestMethod instead."
      />
    </header>

    <!-- Filter -->
    <UInput
      v-model="query"
      icon="i-lucide-search"
      placeholder="Filter endpoints by path, method, or description…"
      size="md"
      class="w-full"
      :ui="{ root: 'sticky top-0 z-10' }"
    />

    <!-- Tag jump nav -->
    <div v-if="!query && groups.length > 1" class="flex flex-wrap gap-1.5">
      <a
        v-for="group in groups"
        :key="group.tag"
        :href="`#${tagAnchor(group.tag)}`"
        class="text-xs px-2 py-1 rounded-md bg-elevated text-muted hover:text-highlighted hover:bg-accented transition-colors"
      >
        {{ group.tag }}
        <span class="text-dimmed">{{ group.operations.length }}</span>
      </a>
    </div>

    <!-- Operations grouped by tag -->
    <div v-if="filteredGroups.length" class="space-y-8">
      <section
        v-for="group in filteredGroups"
        :key="group.tag"
        :id="tagAnchor(group.tag)"
        class="space-y-2 scroll-mt-4"
      >
        <h2 class="text-sm font-semibold uppercase tracking-wide text-dimmed">
          {{ group.tag }}
          <span class="text-dimmed/60">({{ group.operations.length }})</span>
        </h2>
        <ApiOperation v-for="op in group.operations" :key="op.anchor" :item="op" :spec="spec" />
      </section>
    </div>

    <EmptyState v-else icon="i-lucide-search-x" text="No endpoints match your filter." />
  </div>
</template>
