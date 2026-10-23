<script setup lang="ts">
/**
 * "Next" — the one step the page recommends, from `computeNextStep`: the step as
 * a sentence; for a step that copies a code change, the change itself
 * (`buildNextStepChange`): a meta line with the patch's validation, how many
 * lines the window leaves out and "Full patch", then the window as a diff that
 * scrolls inside its box, headed by the call site on a locator step; then one
 * meta line, which says where the step's change comes from (the diagnosis or
 * locator healing) when the page passes that sentence and gives the step's
 * reason otherwise; then one row of actions — the primary action as the block's
 * only solid button, one secondary action inline, and the rest in a small
 * overflow menu, so the first screen keeps its control budget; for the steps
 * where a code change is the work, that menu also copies the retry command to
 * run afterwards. Each action button emits its id and payload; the page turns
 * that into the real behaviour from the same change object, so this component
 * stays presentation-only and reusable across the execution and cluster pages.
 * The block that renders this line provides its label.
 */
import type { DropdownMenuItem } from '@nuxt/ui';
import type { NextStep, NextStepKind } from '#shared/next-step';
import { gitApplyCommand } from '#shared/patch';
import type { NextStepChange } from '~/utils/next-step-change';

const props = defineProps<{
  nextStep: NextStep;
  /** The retry command, offered after the code-change steps. */
  retryCommand?: string | null;
  /** Where the step's change comes from (`nextStepSourceLine`); shown in place of the reason. */
  source?: string | null;
  /** The change the step copies, shown under its title. */
  change?: NextStepChange | null;
  /** The project the call site's open-in-IDE link resolves against. */
  ideProject?: { id?: number | string | null; name?: string | null } | null;
}>();

const emit = defineEmits<{ action: [action: string, payload?: Record<string, unknown>] }>();

// The retry command trails only the steps whose work is a code change.
const RETRY_KINDS: NextStepKind[] = ['replace-locator', 'apply-patch', 'follow-diagnosis'];
const showRetry = computed(() => Boolean(props.retryCommand) && RETRY_KINDS.includes(props.nextStep.kind));

const { copy: copyRetryCmd } = useCopy();

// One secondary inline; the rest fold into a small overflow menu, the retry
// command last.
const inlineSecondary = computed(() => props.nextStep.secondary[0] ?? null);
const overflowSecondary = computed<DropdownMenuItem[]>(() => [
  ...props.nextStep.secondary.slice(1).map((a) => ({
    label: a.label,
    onSelect: () => emit('action', a.action, a.payload),
  })),
  ...(showRetry.value
    ? [
        {
          label: 'Copy retry command',
          onSelect: () => void copyRetryCmd(props.retryCommand!, { toast: 'Retry command copied' }),
        },
      ]
    : []),
]);

// The actions that copy from the change shown: the apply command when there is
// a diff, the recommended locator on a replace step. `app:measure` reads it.
const changeCopies = computed(() => {
  const c = props.change;
  if (!c) return null;
  if (c.kind === 'patch') return 'copy-git-apply';
  return c.copyText ? 'copy-git-apply copy-locator' : 'copy-locator';
});
const hiddenLinesText = computed(() => {
  const n = props.change?.hiddenLines ?? 0;
  return n > 0 ? `${n} more line${n === 1 ? '' : 's'}` : null;
});
const changeMeta = computed(() => [props.change?.validation, hiddenLinesText.value].filter(Boolean) as string[]);

// The primary's title names the command it copies and the shells that run it.
const primaryTitle = computed(() => {
  const text = props.change?.copyText;
  if (props.nextStep.primary.action !== 'copy-git-apply' || !text) return undefined;
  const firstLine = gitApplyCommand(text).split('\n')[0];
  return `${firstLine} ... EOF, run at the repository root (bash, zsh or Git Bash)`;
});
</script>

<template>
  <div data-shot="next-step" :data-next-kind="nextStep.kind" class="space-y-1">
    <p>{{ nextStep.title }}</p>
    <div v-if="change" data-shot="next-step-change" :data-copies="changeCopies" class="space-y-1 pt-0.5">
      <div
        v-if="changeMeta.length || change.kind === 'patch'"
        class="flex flex-wrap items-center gap-x-1.5 text-xs text-muted"
      >
        <template v-for="(fact, i) in changeMeta" :key="fact">
          <span v-if="i > 0" aria-hidden="true">·</span>
          <span>{{ fact }}</span>
        </template>
        <UButton
          v-if="change.kind === 'patch'"
          size="xs"
          color="neutral"
          variant="ghost"
          title="Open the whole patch below"
          @click="emit('action', 'full-patch')"
        >
          Full patch
        </UButton>
      </div>
      <!-- One box, one text style: the call site a locator step rewrites heads the diff. -->
      <div data-diff class="max-w-full overflow-hidden rounded border border-default text-xs font-mono text-muted">
        <div v-if="change.location" class="flex min-w-0 border-b border-default bg-elevated/50 px-3 py-1">
          <OpenInIdeLink
            :location="change.location"
            :project-key="ideProject?.id ?? undefined"
            :project-name="ideProject?.name ?? undefined"
          />
        </div>
        <DiffPatch
          :patch="change.excerpt"
          :file="change.file"
          role="region"
          tabindex="0"
          aria-label="Change preview"
          class="py-1"
        />
      </div>
    </div>
    <p v-if="source" data-shot="next-step-source" class="text-xs text-muted">{{ source }}</p>
    <p v-else-if="nextStep.why" class="text-xs text-muted">{{ nextStep.why }}</p>
    <div class="flex flex-wrap items-center gap-2 pt-1">
      <UButton
        size="xs"
        color="primary"
        variant="solid"
        :data-next-action="nextStep.primary.action"
        :title="primaryTitle"
        data-tour="next-step-action"
        @click="emit('action', nextStep.primary.action, nextStep.primary.payload)"
      >
        {{ nextStep.primary.label }}
      </UButton>
      <UButton
        v-if="inlineSecondary"
        size="xs"
        color="neutral"
        variant="outline"
        @click="emit('action', inlineSecondary.action, inlineSecondary.payload)"
      >
        {{ inlineSecondary.label }}
      </UButton>
      <UDropdownMenu v-if="overflowSecondary.length" :items="overflowSecondary">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-ellipsis"
          aria-label="More next-step actions"
        />
      </UDropdownMenu>
    </div>
  </div>
</template>
