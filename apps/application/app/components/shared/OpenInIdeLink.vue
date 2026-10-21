<script setup lang="ts">
/**
 * Renders a source path (or a `file:line:col` location) as a fully-clickable
 * "open in IDE" link: a dashed-underlined label runs the configured default
 * (Auto by default) and reveals an external-link icon on hover; a caret, shown
 * on hover or keyboard focus, opens a chooser to pick a specific method or copy
 * the path. Phones and touch screens get no caret — the label alone. Inside a
 * line of text (`inline`) the label wraps, shows no icon, and the caret floats
 * over the text that follows instead of taking room. The chooser
 * popover is mounted lazily on first use so lists of these stay cheap to render. All
 * launching/preferences live in `useOpenInIde`; this is a thin, client-only
 * trigger safe to drop in anywhere a path is shown today.
 */
import { parseLocation } from '~/utils/ide-links';

const props = withDefaults(
  defineProps<{
    /** Repo-relative source path. */
    filePath?: string;
    line?: number | null;
    column?: number | null;
    /** Convenience: a `file:line:col` string, parsed when `filePath` is absent. */
    location?: string | null;
    /** Piwi project id — selects the per-project workspace-root/name override. */
    projectKey?: string | number | null;
    /** Piwi project name — default IDE project name for the jetbrains:// URL. */
    projectName?: string | null;
    /** Render the label in a monospace font (default true). */
    mono?: boolean;
    /**
     * The link sits inside a line of text: a long label wraps instead of ending
     * in an ellipsis, and the caret takes no room, showing over the text after
     * the label on hover, so the text runs on right after the path.
     */
    inline?: boolean;
  }>(),
  { mono: true, line: null, column: null, inline: false },
);

defineSlots<{
  /** The link's text; `label` is the path, with `:line` when there is one. */
  default?(props: { label: string }): unknown;
}>();

const { openInIde, openInVscode, openViaJetbrainsUrl, openViaJetbrainsHttp, resolveAbsPath, openSettings } =
  useOpenInIde();
const { copy } = useCopy();

const parsed = computed(() => {
  if (props.filePath) return { filePath: props.filePath, line: props.line ?? null, column: props.column ?? null };
  if (props.location) return parseLocation(props.location);
  return { filePath: '', line: null, column: null };
});

const resolvedPath = computed(() => parsed.value.filePath);
const resolvedLine = computed(() => parsed.value.line);
const label = computed(() => (resolvedLine.value ? `${resolvedPath.value}:${resolvedLine.value}` : resolvedPath.value));
const absPath = computed(() => resolveAbsPath(resolvedPath.value, props.projectKey));

const target = computed(() => ({
  filePath: resolvedPath.value,
  line: resolvedLine.value,
  column: parsed.value.column,
  projectKey: props.projectKey ?? null,
  projectName: props.projectName ?? null,
}));

const open = ref(false);
// The chooser popover is heavy (a teleported menu of actions); keep it out of the
// initial render and only instantiate it the first time the caret is activated.
const menuMounted = ref(false);

function mountMenu() {
  menuMounted.value = true;
  nextTick(() => {
    open.value = true;
  });
}

// The caret appears on hover or keyboard focus, and only where a pointer can
// hover: below `sm` or on a touch screen it is not rendered at all. Inline, it
// floats over the text after the label and catches no click while hidden.
const caretClass = computed(() => [
  'hidden sm:pointer-fine:inline-flex shrink-0 items-center rounded p-0.5 text-muted cursor-pointer transition-opacity hover:bg-elevated/60 hover:text-default opacity-0 group-hover/ide:opacity-100 focus-visible:opacity-100',
  props.inline
    ? 'absolute left-full top-1/2 -translate-y-1/2 bg-default shadow-sm pointer-events-none group-hover/ide:pointer-events-auto focus-visible:pointer-events-auto'
    : '',
]);

function run(action: () => void) {
  open.value = false;
  action();
}
</script>

<template>
  <span
    class="group/ide inline-flex items-center gap-1 min-w-0 max-w-full align-middle"
    :class="inline ? 'relative' : ''"
  >
    <template v-if="resolvedPath">
      <button
        type="button"
        class="inline-flex items-center gap-1 min-w-0 max-w-full cursor-pointer text-left"
        :title="`Open ${label} in IDE`"
        :aria-label="`Open ${label} in IDE`"
        @click="openInIde(target)"
      >
        <span
          :class="[
            mono ? 'font-mono' : '',
            inline ? 'wrap-anywhere' : 'truncate',
            'underline decoration-dashed decoration-1 underline-offset-2 decoration-gray-400/70 dark:decoration-gray-500/70 transition-colors group-hover/ide:decoration-current',
          ]"
        >
          <slot :label="label">{{ label }}</slot>
        </span>
        <UIcon
          v-if="!inline"
          name="i-lucide-external-link"
          class="size-3 shrink-0 opacity-0 transition-opacity group-hover/ide:opacity-100"
        />
      </button>

      <!-- Chooser: mounted lazily on first activation so table rows stay cheap. -->
      <button
        v-if="!menuMounted"
        type="button"
        :class="caretClass"
        aria-label="Choose how to open in IDE"
        title="Choose how to open"
        @click="mountMenu"
      >
        <UIcon name="i-lucide-chevron-down" class="size-3.5" />
      </button>
      <UPopover v-else v-model:open="open">
        <button
          type="button"
          :class="[caretClass, open ? 'opacity-100 pointer-events-auto' : '']"
          aria-label="Choose how to open in IDE"
          title="Choose how to open"
        >
          <UIcon name="i-lucide-chevron-down" class="size-3.5" />
        </button>
        <template #content>
          <div class="w-56 p-1 space-y-0.5">
            <p class="text-xs font-medium text-muted px-2 pt-1 pb-1">Open in IDE</p>

            <UButton
              block
              size="sm"
              color="neutral"
              variant="ghost"
              class="justify-start"
              icon="i-lucide-wand-sparkles"
              @click="run(() => openInIde({ ...target, method: 'auto' }))"
            >
              Auto (try all)
            </UButton>
            <UButton
              block
              size="sm"
              color="neutral"
              variant="ghost"
              class="justify-start"
              icon="i-lucide-code"
              @click="run(() => openInVscode(target))"
            >
              Open in VS Code
            </UButton>
            <UButton
              block
              size="sm"
              color="neutral"
              variant="ghost"
              class="justify-start"
              icon="i-lucide-square-code"
              @click="run(() => openViaJetbrainsUrl(target))"
            >
              JetBrains (URL)
            </UButton>
            <UButton
              block
              size="sm"
              color="neutral"
              variant="ghost"
              class="justify-start"
              icon="i-lucide-server"
              @click="run(() => openViaJetbrainsHttp(target))"
            >
              JetBrains (local server)
            </UButton>

            <USeparator class="my-1" />

            <UButton
              block
              size="sm"
              color="neutral"
              variant="ghost"
              class="justify-start"
              icon="i-lucide-clipboard"
              @click="run(() => copy(resolvedPath, { toast: 'Path copied' }))"
            >
              Copy path
            </UButton>
            <UButton
              v-if="absPath"
              block
              size="sm"
              color="neutral"
              variant="ghost"
              class="justify-start"
              icon="i-lucide-clipboard-check"
              @click="run(() => copy(absPath, { toast: 'Absolute path copied' }))"
            >
              Copy absolute path
            </UButton>

            <USeparator class="my-1" />

            <UButton
              block
              size="sm"
              color="neutral"
              variant="ghost"
              class="justify-start"
              icon="i-lucide-settings"
              @click="
                run(() =>
                  openSettings({
                    projectKey: target.projectKey ? String(target.projectKey) : null,
                    projectName: target.projectName,
                  }),
                )
              "
            >
              Configure…
            </UButton>
          </div>
        </template>
      </UPopover>
    </template>

    <span v-else :class="[mono ? 'font-mono' : '', 'truncate']">
      <slot :label="label">{{ label }}</slot>
    </span>
  </span>
</template>
