<script setup lang="ts">
/**
 * The prerequisite row for a feature page — a reader sees what a feature needs
 * before the first paragraph, and each chip links to the page that switches the
 * prerequisite on. Each boolean prop is one prerequisite chip; declare exactly
 * what the feature needs:
 *
 *   <Needs reporter fixtures />
 *   <Needs desktop />
 *
 * The chips, their order and their setup pages follow the feature catalog
 * (apps/application/shared/piwi-features.ts), which also renders the All
 * features page.
 */
import { withBase } from 'vitepress'
import { FEATURE_NEED_DOCS, type FeatureNeed } from '#shared/piwi-features'

const props = defineProps<{
  reporter?: boolean
  fixtures?: boolean
  llm?: boolean
  scm?: boolean
  backend?: boolean
  desktop?: boolean
  extension?: boolean
  editor?: boolean
  admin?: boolean
}>()

// Fixed order so every page reads the same way, baseline first.
const CHIPS: { key: keyof typeof props; label: string; doc: string }[] = [
  { key: 'reporter', label: 'Reporter', doc: 'guide/reporter' },
  ...(
    [
      ['fixtures', 'Capture fixtures'],
      ['llm', 'AI key'],
      ['scm', 'SCM token'],
      ['backend', 'Backend integration'],
      ['desktop', 'Desktop app'],
      ['extension', 'Browser extension'],
      ['editor', 'Editor extension'],
      ['admin', 'Administrator'],
    ] as [FeatureNeed, string][]
  ).map(([key, label]) => ({ key, label, doc: FEATURE_NEED_DOCS[key] })),
]

const active = CHIPS.filter((c) => props[c.key])
</script>

<template>
  <p class="needs" aria-label="Prerequisites">
    <span class="needs-label">Needs</span>
    <a v-for="chip in active" :key="chip.key" class="needs-chip" :href="withBase(`/${chip.doc}`)">{{ chip.label }}</a>
  </p>
</template>

<style scoped>
.needs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0 0 20px;
}
.needs-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-3);
  margin-right: 2px;
}
.needs-chip {
  padding: 2px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  white-space: nowrap;
  text-decoration: none;
  transition: color 0.2s, border-color 0.2s;
}
.needs-chip:hover,
.needs-chip:focus-visible {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}
</style>
