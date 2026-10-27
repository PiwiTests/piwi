<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core';

const config = useRuntimeConfig();
const bannerEl = useTemplateRef<HTMLElement>('banner');

if (config.public.demoMode) {
  useResizeObserver(bannerEl, (entries) => {
    const entry = entries[0];
    if (!entry) return;
    // getBoundingClientRect gives the exact rendered height (content + padding + border)
    // which is what the layout needs for its top offset.
    const height = (entry.target as HTMLElement).getBoundingClientRect().height;
    document.documentElement.style.setProperty('--demo-banner-height', `${height}px`);
  });

  onUnmounted(() => {
    document.documentElement.style.removeProperty('--demo-banner-height');
  });
}
</script>

<template>
  <Teleport v-if="config.public.demoMode" to="body">
    <div ref="banner" class="demo-banner">
      <div class="demo-banner-inner">
        <span>
          ⚠️ <strong>Demo mode</strong> — sample data running in your browser.
          <a href="https://github.com/piwitests/piwi" target="_blank" class="underline">Deploy your own instance</a>
          for live data.
        </span>
        <LazyDemoTourButton v-if="config.public.demoTour" />
        <DemoUserSwitcher />
        <DemoSimulator />
        <DemoResetButton />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.demo-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 60;
  background-color: #fef3c7;
  color: #92400e;
  text-align: center;
  padding: 0.375rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  border-bottom: 1px solid #fcd34d;
}

.demo-banner-inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.375rem 1rem;
}

.dark .demo-banner {
  background-color: #451a03;
  color: #fcd34d;
  border-bottom-color: #78350f;
}
</style>
