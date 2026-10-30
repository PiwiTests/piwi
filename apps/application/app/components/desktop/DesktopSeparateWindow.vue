<script setup lang="ts">
/**
 * Desktop shell only: renders its slot in a separate window of the app. The
 * window is a blank page of the dashboard's origin, opened with
 * `window.open('about:blank#<name>')`, the one kind of URL the shell opens a
 * window for, and closed by the shell (`output_window` and
 * `desktop_close_output_window` in `src-tauri/src/lib.rs`). The slot stays a
 * part of this page, so it keeps updating with it. The window takes this
 * page's stylesheets and color mode. `name`: lowercase letters, digits and
 * dashes.
 *
 * Closing the window emits `closed` with `opened: true`; a window that could
 * not be opened emits it with `false`. Unmounting the component, or leaving the
 * page, closes the window.
 */
const props = defineProps<{ name: string; title: string }>();
const emit = defineEmits<{ closed: [opened: boolean] }>();

const target = shallowRef<HTMLElement | null>(null);
let popup: Window | null = null;
let colorObserver: MutationObserver | null = null;

/** This page's stylesheets, copied into the window's head. */
function copyStylesheets(doc: Document) {
  const sheets = [...document.head.querySelectorAll('style, link[rel="stylesheet"]')].map((node) => {
    const copy = node.cloneNode(true) as Element;
    if (node instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = node.href;
    return copy;
  });
  doc.head.replaceChildren(...sheets);
}

function syncDocument() {
  if (!popup || popup.closed) return;
  popup.document.title = props.title;
  popup.document.documentElement.className = document.documentElement.className;
}

function closeWindow() {
  colorObserver?.disconnect();
  target.value = null;
  if (popup && !popup.closed) {
    tauriCore()
      ?.invoke('desktop_close_output_window', { name: props.name })
      .catch(() => {});
    popup.close();
  }
  popup = null;
}

/** The window's page, ready for the slot: this page's stylesheets, and a root to render into. */
function prepare(doc: Document) {
  copyStylesheets(doc);
  const root = doc.createElement('div');
  root.className = 'h-screen bg-default text-default';
  doc.body.style.margin = '0';
  doc.body.replaceChildren(root);
  syncDocument();
  target.value = root;
}

onMounted(() => {
  popup = window.open(`about:blank#${props.name}`, props.name, 'popup,width=960,height=640');
  if (!popup) {
    emit('closed', false);
    return;
  }
  prepare(popup.document);
  colorObserver = new MutationObserver(syncDocument);
  colorObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
});

watch(() => props.title, syncDocument);

useIntervalFn(() => {
  if (!popup) return;
  if (popup.closed) {
    closeWindow();
    emit('closed', true);
    return;
  }
  // A blank page that loads after the window opened replaces the prepared one: prepare it again.
  if (target.value?.ownerDocument !== popup.document) prepare(popup.document);
}, 500);

useEventListener('pagehide', closeWindow);
onBeforeUnmount(closeWindow);
</script>

<template>
  <Teleport v-if="target" :to="target">
    <slot />
  </Teleport>
</template>
