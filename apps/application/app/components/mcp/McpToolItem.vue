<script setup lang="ts">
/**
 * One tool of the `/mcp` page's catalog: its name and one-sentence summary, and
 * one click below, the rest of its Markdown description and its parameters.
 */
import { toolDetails, toolParameters, toolPermissions, toolSummary, type McpToolDef } from '#shared/mcp-tools';
import { inlineMarkdownHtml } from '~/utils/markdown-inline';

const props = defineProps<{
  tool: McpToolDef;
  /** A tool this instance does not serve, listed in a muted row. */
  muted?: boolean;
}>();

const open = ref(false);
const panelId = useId();

const summaryHtml = computed(() => inlineMarkdownHtml(toolSummary(props.tool.description)));
const details = computed(() => toolDetails(props.tool.description));
const permissions = computed(() => toolPermissions(props.tool));
const parameters = computed(() =>
  toolParameters(props.tool).map((p) => ({ ...p, html: inlineMarkdownHtml(p.description) })),
);
</script>

<template>
  <div class="rounded-md border border-default" :class="muted ? '' : 'bg-elevated/50'">
    <button
      type="button"
      class="flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
      :aria-expanded="open"
      :aria-controls="panelId"
      @click="open = !open"
    >
      <UIcon
        name="i-lucide-chevron-right"
        class="size-4 mt-0.5 shrink-0 text-muted transition-transform"
        :class="{ 'rotate-90': open }"
      />
      <span class="min-w-0 flex-1">
        <span class="flex flex-wrap items-baseline gap-x-2">
          <span class="text-sm font-mono font-semibold break-all" :class="muted ? 'text-muted' : 'text-highlighted'">
            {{ tool.name }}
          </span>
          <span v-if="permissions.length" class="text-xs text-muted">needs {{ permissions.join(' or ') }}</span>
        </span>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <span class="block text-xs text-muted mt-0.5" v-html="summaryHtml" />
      </span>
    </button>

    <div v-if="open" :id="panelId" class="space-y-4 pb-3 pl-10 pr-3 max-sm:pl-3">
      <MarkdownPreview v-if="details" :text="details" variant="prose" />
      <div>
        <p class="text-sm font-semibold text-highlighted mb-1.5">Parameters</p>
        <dl v-if="parameters.length" class="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <template v-for="p in parameters" :key="p.name">
            <dt class="min-w-0 text-xs">
              <code class="font-mono text-highlighted break-all">{{ p.name }}</code
              >{{ ' ' }}
              <span class="text-muted">{{ p.type }}{{ p.required ? ', required' : '' }}</span>
            </dt>
            <dd class="min-w-0 text-xs text-muted max-sm:mb-1">
              <!-- eslint-disable-next-line vue/no-v-html -->
              <span v-html="p.html" />
              <span v-if="p.values.length" class="mt-1 flex flex-wrap gap-1">
                <code
                  v-for="value in p.values"
                  :key="value"
                  class="rounded bg-gray-200 dark:bg-gray-700 px-1 py-px font-mono"
                  >{{ value }}</code
                >
              </span>
            </dd>
          </template>
        </dl>
        <p v-else class="text-xs text-muted">None.</p>
      </div>
    </div>
  </div>
</template>
