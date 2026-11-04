<script setup lang="ts">
import type { BrowserConfig } from '#shared/types';

const props = defineProps<{
  browser: BrowserConfig | null | undefined;
  size?: 'sm' | 'md' | 'lg';
}>();

const name = computed(() => props.browser?.projectName ?? null);
const icon = computed(() => getBrowserIcon(browserIconName(props.browser)));
const hexColor = computed(() => getBrowserHexColor(browserIconName(props.browser)));

const iconSizeClass = computed(() => (props.size === 'sm' ? 'size-3.5' : props.size === 'lg' ? 'size-5' : 'size-4'));

const tooltipLines = computed(() => {
  const b = props.browser;
  if (!b) return [];
  const lines: string[] = [];
  if (b.browserName && b.browserName !== name.value) lines.push(`Browser: ${b.browserName}`);
  if (b.channel) lines.push(`Channel: ${b.channel}`);
  if (b.viewport) lines.push(`Viewport: ${b.viewport.width}×${b.viewport.height}`);
  if (b.deviceScaleFactor && b.deviceScaleFactor !== 1) lines.push(`Scale: ${b.deviceScaleFactor}x`);
  if (b.isMobile) lines.push('Mobile');
  if (b.hasTouch && !b.isMobile) lines.push('Touch');
  if (b.locale) lines.push(`Locale: ${b.locale}`);
  if (b.timezoneId) lines.push(`TZ: ${b.timezoneId}`);
  if (b.colorScheme && b.colorScheme !== 'light') lines.push(`Color: ${b.colorScheme}`);
  if (b.reducedMotion && b.reducedMotion !== 'no-preference') lines.push(`Motion: ${b.reducedMotion}`);
  if (b.forcedColors && b.forcedColors !== 'none') lines.push(`Colors: forced`);
  if (b.offline) lines.push('Offline');
  if (b.bypassCSP) lines.push('CSP bypassed');
  if (b.javaScriptEnabled === false) lines.push('JS disabled');
  if (b.serviceWorkers === 'block') lines.push('SW blocked');
  if (b.geolocation) lines.push(`Geo: ${b.geolocation.latitude.toFixed(2)},${b.geolocation.longitude.toFixed(2)}`);
  if (b.userAgent) lines.push(`UA: ${b.userAgent.length > 60 ? b.userAgent.slice(0, 60) + '…' : b.userAgent}`);
  return lines;
});

// The browser name is not shown inline, so surface it (plus any config) on hover.
const tooltipText = computed(() => {
  if (!name.value) return '';
  return tooltipLines.value.length ? `${name.value} · ${tooltipLines.value.join(' · ')}` : name.value;
});
</script>

<template>
  <DeferredTooltip v-if="name" :text="tooltipText" :popper="{ placement: 'top' }">
    <span class="shrink-0 cursor-help inline-flex" role="img" :aria-label="name">
      <UIcon :name="icon" :class="iconSizeClass" :style="{ color: hexColor }" />
    </span>
  </DeferredTooltip>
  <span v-else class="text-xs text-gray-400 dark:text-gray-500 italic">—</span>
</template>
