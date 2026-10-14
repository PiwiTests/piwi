<script setup lang="ts">
/**
 * A rendered DOM snapshot: the page in a hardened, opaque-origin iframe
 * (`sandbox="allow-scripts"`), scaled down to the stage's width at the recorded
 * viewport's proportions and scrolling inside the stage when it is taller. The
 * frame reports its content height, so the canvas fits the whole page, and
 * where the page was scrolled, so the stage opens on what the page showed. The
 * stage takes the width it is given and never sizes its container (a table
 * cell would otherwise grow to the recorded viewport). Load it with
 * `useDomSnapshot`, which says where the frame comes from.
 */
const props = withDefaults(
  defineProps<{
    /** The served frame (`dom-snapshot-frame`); the demo passes `srcDoc` instead. */
    frameSrc?: string;
    srcDoc?: string;
    /** The recorded page viewport; the frame fills the stage when unknown. */
    viewport: { width: number; height: number } | null;
    /** The iframe's accessible title. */
    title: string;
    /** The stage's height class. */
    stageClass?: string;
  }>(),
  { frameSrc: undefined, srcDoc: undefined, stageClass: 'h-96' },
);

const iframeRef = ref<HTMLIFrameElement | null>(null);
const contentHeight = ref(0);
const stageRef = ref<HTMLElement | null>(null);
const stageWidth = ref(0);

const fitZoom = computed(() => {
  const vp = props.viewport;
  if (!vp?.width || !stageWidth.value) return 1;
  return Math.min(stageWidth.value / vp.width, 1);
});
const canvasStyle = computed(() => {
  const vp = props.viewport;
  if (!vp) return { width: '100%', height: contentHeight.value ? `${contentHeight.value}px` : '100%' };
  const h = contentHeight.value || vp.height;
  return { width: `${Math.round(vp.width * fitZoom.value)}px`, height: `${Math.round(h * fitZoom.value)}px` };
});
const iframeStyle = computed(() => {
  const vp = props.viewport;
  if (!vp) return { width: '100%', height: contentHeight.value ? `${contentHeight.value}px` : '100%', border: '0' };
  const h = contentHeight.value || vp.height;
  return {
    width: `${vp.width}px`,
    height: `${h}px`,
    transform: `scale(${fitZoom.value})`,
    transformOrigin: 'top left',
    border: '0',
  };
});

function handleMessage(event: MessageEvent) {
  if (!iframeRef.value || event.source !== iframeRef.value.contentWindow) return;
  if (event.data?.type === 'piwiContentHeight' && typeof event.data.height === 'number') {
    contentHeight.value = Math.max(event.data.height, props.viewport?.height ?? 0);
  }
  // Where the page was scrolled, or the dialog it showed on top (content-space
  // y → stage-space via the zoom).
  if (event.data?.type === 'piwiScrollTo' && typeof event.data.y === 'number') {
    stageRef.value?.scrollTo({ top: Math.max(0, event.data.y * fitZoom.value - 16) });
  }
}

let stageObserver: ResizeObserver | null = null;
watch(stageRef, (el) => {
  stageObserver?.disconnect();
  if (!el) return;
  stageWidth.value = el.clientWidth;
  stageObserver = new ResizeObserver((entries) => {
    for (const e of entries) stageWidth.value = e.contentRect.width;
  });
  stageObserver.observe(el);
});
onMounted(() => window.addEventListener('message', handleMessage));
onBeforeUnmount(() => {
  window.removeEventListener('message', handleMessage);
  stageObserver?.disconnect();
});
</script>

<template>
  <div
    ref="stageRef"
    class="relative overflow-auto rounded-lg border border-default bg-gray-100 [contain:inline-size] dark:bg-gray-800"
    :class="stageClass"
  >
    <div :style="canvasStyle">
      <iframe
        ref="iframeRef"
        :src="frameSrc"
        :srcdoc="srcDoc"
        :style="iframeStyle"
        class="bg-white"
        sandbox="allow-scripts"
        :title="title"
      />
    </div>
  </div>
</template>
