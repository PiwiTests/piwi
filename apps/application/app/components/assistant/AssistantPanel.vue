<script setup lang="ts">
/**
 * The assistant's panel. From 1280 px up it docks beside the page, which
 * narrows to make room, with a handle on its edge to widen it, unless the
 * user floats it over the page; below 1536 px a docked panel folds the
 * sidebar to its rail so the page keeps its room, and unfolds it once it
 * closes. Below 1280 px it is a side panel over a page that stays usable,
 * and a full-screen sheet on a phone. It keeps its conversation across
 * navigation, and Ctrl+I (⌘I on a Mac) opens it, puts the caret in its
 * input, or closes it from there.
 */
import { ASSISTANT_DOCK_WIDTH } from '~/composables/useAssistantDock';

const { open, view, available, loadStatus, openPanel } = useAssistant();
const { docked, width } = useAssistantDock();
const config = useRuntimeConfig();
const { width: windowWidth } = useWindowSize();

const nuxtApp = useNuxtApp();
const input = useTemplateRef<{ focus: () => void; focused: () => boolean }>('input');
const aside = useTemplateRef<HTMLElement>('aside');

/**
 * The panel's content props over the page: a click or focus on the page
 * beside it leaves it open, and `data-shot` names it for the screenshot harness.
 */
const contentProps = {
  onInteractOutside: (event: Event) => event.preventDefault(),
  'data-shot': 'assistant-panel',
};

/**
 * The panel's width over the page, and in the demo its top: under the demo
 * banner, whose height the banner sets on the page (`--demo-banner-height`),
 * so the header and its Close button stay clear of it.
 */
const contentClass = config.public.demoMode
  ? 'max-w-none sm:max-w-lg top-(--demo-banner-height)'
  : 'max-w-none sm:max-w-lg';

const rootPx = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

/** The widest the docked panel goes, in rem: the range's top, and never more than half the window. */
const maxWidth = computed(() =>
  import.meta.client ? Math.min(ASSISTANT_DOCK_WIDTH.max, windowWidth.value / 2 / rootPx()) : ASSISTANT_DOCK_WIDTH.max,
);

function clampWidth(rem: number): number {
  return Math.round(Math.min(maxWidth.value, Math.max(ASSISTANT_DOCK_WIDTH.min, rem)) * 4) / 4;
}

const dockedWidth = computed(() => clampWidth(width.value));

/** Dragging the handle on the docked panel's edge sets its width; the handle sits on its left, so left widens it. */
function startResize(event: PointerEvent): void {
  const el = aside.value;
  const handle = event.currentTarget as HTMLElement;
  if (!el || event.button !== 0) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startWidth = el.getBoundingClientRect().width;
  const px = rootPx();
  const move = (e: PointerEvent) => {
    width.value = clampWidth((startWidth + startX - e.clientX) / px);
  };
  const end = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/** The arrow keys resize from the keyboard: Left widens, Right narrows. */
function resizeByKey(event: KeyboardEvent): void {
  const step = { ArrowLeft: 1, ArrowRight: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  width.value = clampWidth(dockedWidth.value + step);
}

/** Below this width a docked panel needs the room of the expanded sidebar. */
const FOLD_QUERY = '(max-width: 1535px)';
/** The layout's sidebar, whose root says whether it is folded. */
const SIDEBAR_ID = 'dashboard-sidebar-default';
/** Set while the sidebar is folded by the panel, so a reload in between unfolds it. */
const FOLDED_KEY = 'piwi-assistant-folded-sidebar';

const narrow = useMediaQuery(FOLD_QUERY);

function sidebarFolded(): boolean {
  return document.getElementById(SIDEBAR_ID)?.dataset.collapsed === 'true';
}

function foldedByPanel(value?: boolean): boolean {
  try {
    if (value === true) sessionStorage.setItem(FOLDED_KEY, '1');
    else if (value === false) sessionStorage.removeItem(FOLDED_KEY);
    return sessionStorage.getItem(FOLDED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Folds the sidebar while a docked panel needs its room, and unfolds it after, when the panel folded it. */
function makeRoom(needed: boolean): void {
  if (needed && !sidebarFolded()) {
    foldedByPanel(true);
    void nuxtApp.hooks.callHook('dashboard:sidebar:collapse', true);
  } else if (!needed && foldedByPanel()) {
    foldedByPanel(false);
    if (sidebarFolded()) void nuxtApp.hooks.callHook('dashboard:sidebar:collapse', false);
  }
}

const needsRoom = computed(() => open.value && docked.value && narrow.value);
watch(needsRoom, makeRoom);
onMounted(() => makeRoom(needsRoom.value));

defineShortcuts({
  meta_i: {
    usingInput: true,
    handler: () => {
      if (!open.value) void openPanel();
      else if (input.value?.focused()) open.value = false;
      else input.value?.focus();
    },
  },
});

watch(open, (isOpen) => {
  if (!isOpen) return;
  void loadStatus(!available.value);
  nextTick(() => input.value?.focus());
});
</script>

<template>
  <aside
    v-if="open && docked"
    ref="aside"
    class="relative flex h-full max-w-[50vw] shrink-0 flex-col border-l border-default bg-default"
    :style="{ width: `${dockedWidth}rem` }"
    aria-label="Ask Piwi"
    data-shot="assistant-panel"
    data-assistant-docked
  >
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the assistant panel"
      :aria-valuenow="dockedWidth"
      :aria-valuemin="ASSISTANT_DOCK_WIDTH.min"
      :aria-valuemax="maxWidth"
      tabindex="0"
      title="Drag to resize; double-click to reset"
      class="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40"
      data-assistant-resize
      @pointerdown="startResize"
      @keydown="resizeByKey"
      @dblclick="width = ASSISTANT_DOCK_WIDTH.initial"
    />
    <div class="flex h-(--ui-header-height) shrink-0 items-center gap-1.5 border-b border-default px-4 sm:px-6">
      <h2 class="font-semibold text-highlighted">Ask Piwi</h2>
      <AssistantPanelActions class="ml-auto" />
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        aria-label="Close"
        title="Close"
        @click="open = false"
      />
    </div>
    <AssistantPanelBody class="min-h-0 flex-1" />
    <div v-if="available && view === 'conversation'" class="shrink-0 border-t border-default p-4 sm:px-6">
      <AssistantInput ref="input" />
    </div>
  </aside>
  <USlideover
    v-else
    v-model:open="open"
    :modal="false"
    :overlay="false"
    title="Ask Piwi"
    description="Answers about your runs, failures and setup, from the data you can read."
    :content="contentProps"
    :ui="{
      content: contentClass,
      description: 'sr-only',
      body: 'p-0 sm:p-0 flex flex-col min-h-0 overflow-hidden',
      footer: 'flex-col items-stretch',
    }"
  >
    <template #actions>
      <AssistantPanelActions class="ml-auto mr-8" />
    </template>

    <template #body>
      <AssistantPanelBody class="flex-1" />
    </template>

    <template v-if="available && view === 'conversation'" #footer>
      <AssistantInput ref="input" />
    </template>
  </USlideover>
</template>
