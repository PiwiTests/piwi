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

const DEPLOY_URL = 'https://github.com/piwitests/piwi';
</script>

<template>
  <Teleport v-if="config.public.demoMode" to="body">
    <div ref="banner" class="demo-banner">
      <div class="demo-banner-inner">
        <!-- On a phone the sentence fits one line, so the controls fit the next. -->
        <span class="max-sm:hidden">
          ⚠️ <strong>Demo mode</strong> — sample data running in your browser.
          <a :href="DEPLOY_URL" target="_blank" class="underline">Deploy your own instance</a>
          for live data.
        </span>
        <span class="text-xs sm:hidden">
          <strong>Demo</strong> · sample data in your browser ·
          <a :href="DEPLOY_URL" target="_blank" class="underline">Deploy your own</a>
        </span>
        <div class="demo-banner-controls">
          <LazyDemoTourButton v-if="config.public.demoTour" />
          <DemoUserSwitcher />
          <DemoSimulator />
          <DemoResetButton />
        </div>
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

.demo-banner-inner,
.demo-banner-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.375rem 1rem;
}

.demo-banner-controls {
  gap: 0.375rem;
}

@media (max-width: 639.98px) {
  .demo-banner {
    padding: 0.375rem 0.75rem;
  }

  .demo-banner-inner {
    flex-direction: column;
    gap: 0.25rem;
  }

  .demo-banner-controls {
    width: 100%;
  }
}

@media (min-width: 640px) {
  .demo-banner-controls {
    display: contents;
  }
}

.dark .demo-banner {
  background-color: #451a03;
  color: #fcd34d;
  border-bottom-color: #78350f;
}
</style>
