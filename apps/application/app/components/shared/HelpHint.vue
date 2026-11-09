<script setup lang="ts">
/**
 * Discreet inline-help affordance: a small muted help icon that opens a popover
 * with a short explanation, an optional "Learn more" docs link and, for a
 * registry topic, an optional link to the recipe it raises. Resolve copy
 * from the shared registry via `topic`, or pass `title`/`text`/`doc` inline for
 * one-offs. The actions slot adds contextual controls inside the popover.
 *
 * The text is Markdown (see `renderHelpMarkdown`): a long hint reads as a lead
 * sentence and a list. Such a hint gets a wider popover that scrolls when it
 * outgrows the viewport.
 *
 * Click-mode popover (not a hover tooltip) so the content can hold a real link
 * and stay keyboard- and touch-accessible. Use `i-lucide-circle-help` here and
 * reserve `i-lucide-info` for informational/empty-state callouts.
 */
import { HELP_TOPICS, type HelpTopic, type HelpTopicKey } from '~/utils/help-content';
import { renderHelpMarkdown } from '~/utils/help-markdown';
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';
import { getEnvVarMeta } from '#shared/piwi-env-vars';

const props = defineProps<{
  /** Resolve copy from the registry… */
  topic?: HelpTopicKey;
  /** …or pass inline for rare one-offs. */
  title?: string;
  text?: string;
  doc?: string;
  /** Env var(s) that override this setting; shown as copyable mono lines. */
  envVars?: PiwiEnvVarName[];
  /** Trigger icon size. Default 'xs'. */
  size?: 'xs' | 'sm';
}>();

const { copy } = useCopy();

const entry = computed<HelpTopic | null>(() => (props.topic ? HELP_TOPICS[props.topic] : null));
const title = computed(() => props.title ?? entry.value?.title);
const text = computed(() => props.text ?? entry.value?.text ?? '');
const doc = computed(() => props.doc ?? entry.value?.doc);
const recipe = computed(() => entry.value?.recipe);
const envVars = computed(() => props.envVars ?? entry.value?.envVars);

const open = ref(false);

// Rendered only once opened: most hints on a page are never read.
const html = computed(() => (open.value ? renderHelpMarkdown(text.value) : ''));
// Prose of a sentence or two stays narrow; structured or long copy reads better wider.
const wide = computed(() => /^\s*(?:[-*]|\d+\.)\s/m.test(text.value) || text.value.length > 400);
const contentClass = computed(() => [
  'p-3 text-sm overflow-y-auto max-h-(--reka-popover-content-available-height)',
  wide.value ? 'max-w-[min(28rem,calc(100vw-2rem))]' : 'max-w-xs',
]);

// Names both the trigger and the popover it opens, so assistive tech announces
// which hint is on screen.
const ariaLabel = computed(() => (title.value ? `Help: ${title.value}` : 'Help'));
// Rides along with the positioning props Reka spreads onto the popover element.
const contentAttrs = computed(() => ({ side: 'bottom' as const, 'aria-label': ariaLabel.value }));
</script>

<template>
  <UPopover v-model:open="open" :content="contentAttrs" :ui="{ content: contentClass }">
    <UButton
      :size="size ?? 'xs'"
      variant="ghost"
      color="neutral"
      icon="i-lucide-circle-help"
      :aria-label="ariaLabel"
      title="What is this?"
      class="text-muted hover:text-default align-middle"
    />

    <template #content>
      <p v-if="title" class="font-medium mb-1">{{ title }}</p>
      <!-- eslint-disable-next-line vue/no-v-html — registry copy; raw HTML in it is escaped -->
      <div
        class="text-muted break-words [&_p+*]:mt-2 [&_ul+p]:mt-2 [&_ol+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li+li]:mt-1 [&_strong]:font-medium [&_strong]:text-default [&_code]:font-mono [&_code]:text-xs [&_code]:bg-elevated [&_code]:rounded [&_code]:px-0.5 [&_a]:text-primary [&_a]:underline [&_a]:decoration-dotted"
        v-html="html"
      />
      <div v-if="envVars?.length" class="mt-2 space-y-1">
        <p class="text-muted text-xs">Environment variable{{ envVars.length > 1 ? 's' : '' }}:</p>
        <div class="flex flex-col gap-1.5">
          <button
            v-for="v in envVars"
            :key="v"
            type="button"
            class="group text-left"
            :title="`Click to copy ${v}`"
            @click="copy(v, { toast: `Copied ${v}` })"
          >
            <code
              class="block font-mono text-xs bg-elevated rounded px-1.5 py-0.5 select-all cursor-pointer group-hover:ring-1 ring-default"
            >
              {{ v }}
            </code>
            <span v-if="getEnvVarMeta(v).description" class="block text-muted text-[11px] mt-0.5">
              {{ getEnvVarMeta(v).description }}
            </span>
          </button>
        </div>
      </div>
      <div v-if="doc || recipe || envVars?.length || $slots.actions" class="mt-2 flex flex-col gap-1">
        <slot name="actions" />
        <DocLink v-if="doc" :to="doc">Learn more</DocLink>
        <DocLink v-if="recipe" :to="recipe.doc">{{ recipe.question }}</DocLink>
        <DocLink v-if="envVars?.length" to="reference/configuration">Configuration reference</DocLink>
      </div>
    </template>
  </UPopover>
</template>
