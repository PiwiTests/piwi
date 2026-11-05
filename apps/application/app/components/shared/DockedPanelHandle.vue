<script setup lang="ts">
/**
 * The handle on the left edge of a panel docked at the page's right edge (its parent element): dragging it sets the
 * panel's width (left widens it), the arrow keys step it, a double-click puts it back to where it starts. Widths are in
 * rem, held between `min` and `max`.
 */
const props = defineProps<{
  /** The width the panel shows. */
  width: number;
  min: number;
  max: number;
  /** The width a double-click puts back. */
  initial: number;
  /** What the handle resizes, for a screen reader: "Resize the assistant panel". */
  label: string;
}>();
const emit = defineEmits<{ 'update:width': [rem: number] }>();

const rootPx = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

function set(rem: number): void {
  emit('update:width', Math.round(Math.min(props.max, Math.max(props.min, rem)) * 4) / 4);
}

function startResize(event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement;
  const panel = handle.parentElement;
  if (!panel || event.button !== 0) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startWidth = panel.getBoundingClientRect().width;
  const px = rootPx();
  const move = (e: PointerEvent) => set((startWidth + startX - e.clientX) / px);
  const end = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/** Left widens, Right narrows. */
function resizeByKey(event: KeyboardEvent): void {
  const step = { ArrowLeft: 1, ArrowRight: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  set(props.width + step);
}
</script>

<template>
  <div
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuenow="width"
    :aria-valuemin="min"
    :aria-valuemax="max"
    tabindex="0"
    title="Drag to resize; double-click to reset"
    class="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40"
    @pointerdown="startResize"
    @keydown="resizeByKey"
    @dblclick="set(initial)"
  />
</template>
