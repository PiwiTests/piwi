<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  PIWI_ENV_CATEGORIES,
  PIWI_ENV_VARS,
  compareVersions,
  envVarAppliesToVersion,
  knownRegistryVersions,
  type PiwiEnvVarCategory,
  type PiwiEnvVarMeta,
  type PiwiEnvVarName,
} from '#shared/piwi-env-vars'
import { ENV_OUTPUT_FORMATS, ENV_OUTPUT_GROUPS, imageForVersion, type EnvEntry } from '#shared/env-format'
import appPackage from '../../../../application/package.json'

const registry = PIWI_ENV_VARS as Record<PiwiEnvVarName, PiwiEnvVarMeta>
const allNames = Object.keys(registry) as PiwiEnvVarName[]

// ── Server version filter ────────────────────────────────────────────────────
const currentVersion: string = appPackage.version
const versionOptions = computed(() => {
  const versions = new Set([currentVersion, ...knownRegistryVersions()])
  return [...versions].sort(compareVersions).reverse()
})
const serverVersion = ref(currentVersion)

// ── Form state ───────────────────────────────────────────────────────────────
const values = reactive<Record<string, string>>({})
const revealed = reactive<Record<string, boolean>>({})

function effective(name: string): string {
  const set = values[name]
  if (set !== undefined && set !== '') return set
  return (registry[name as PiwiEnvVarName]?.default as string | undefined) ?? ''
}

function conditionMet(condition: Readonly<Record<string, string>> | undefined): boolean {
  if (!condition) return true
  return Object.entries(condition).every(([other, expected]) => {
    const value = effective(other)
    if (expected === '*') return value !== ''
    if (expected === '') return value === ''
    return value === expected
  })
}

function conditionLabel(condition: Readonly<Record<string, string>>): string {
  return Object.entries(condition)
    .map(([other, expected]) => (expected === '*' ? `${other} is set` : expected === '' ? `${other} is unset` : `${other}=${expected}`))
    .join(' and ')
}

// ── Sections (mirror the generated reference page) ───────────────────────────
const COLLAPSED_BY_DEFAULT: readonly PiwiEnvVarCategory[] = ['ai-limits', 'ingest', 'clustering', 'testing']

interface WizardSection {
  category: PiwiEnvVarCategory
  title: string
  intro?: string
  collapsed: boolean
  vars: PiwiEnvVarName[]
}

const sections = computed<WizardSection[]>(() => {
  const parents = (Object.entries(PIWI_ENV_CATEGORIES) as Array<[PiwiEnvVarCategory, (typeof PIWI_ENV_CATEGORIES)[PiwiEnvVarCategory]]>)
    .filter(([, meta]) => !meta.internal && !meta.mergeInto)
    .sort(([, a], [, b]) => a.order - b.order)
  return parents
    .map(([category, meta]) => {
      const merged = (Object.entries(PIWI_ENV_CATEGORIES) as Array<[PiwiEnvVarCategory, (typeof PIWI_ENV_CATEGORIES)[PiwiEnvVarCategory]]>)
        .filter(([, m]) => m.mergeInto === category && !m.internal)
        .map(([c]) => c)
      const vars = allNames.filter((name) => {
        const varMeta = registry[name]
        if (varMeta.runtimeOnly) return false
        if (varMeta.category !== category && !merged.includes(varMeta.category)) return false
        if (!envVarAppliesToVersion(name, serverVersion.value)) return false
        return conditionMet(varMeta.relevantWhen)
      })
      return {
        category,
        title: meta.title,
        intro: meta.intro,
        collapsed: COLLAPSED_BY_DEFAULT.includes(category),
        vars,
      }
    })
    .filter((section) => section.vars.length > 0)
})

// ── Presets ──────────────────────────────────────────────────────────────────
interface Preset {
  id: string
  label: string
  hint: string
  values: Partial<Record<PiwiEnvVarName, string>>
}

const PRESETS: Preset[] = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    hint: 'External database instead of SQLite',
    values: { PIWI_DATABASE_URL: 'postgres://piwi:piwi@db:5432/piwi' },
  },
  {
    id: 's3',
    label: 'S3 artifact storage',
    hint: 'Reports and traces in a bucket',
    values: { PIWI_STORAGE_TYPE: 's3' },
  },
  {
    id: 'team',
    label: 'Team setup',
    hint: 'Authentication + public URL',
    values: { PIWI_AUTH_ENABLED: 'true', PIWI_SITE_URL: 'https://piwi.example.com' },
  },
  {
    id: 'ai-anthropic',
    label: 'AI diagnosis (Anthropic)',
    hint: 'Claude analyzes failure clusters',
    values: { PIWI_AI_PROVIDER: 'anthropic' },
  },
  {
    id: 'ai-openai',
    label: 'AI diagnosis (OpenAI-compatible)',
    hint: 'Any OpenAI-style endpoint',
    values: { PIWI_AI_PROVIDER: 'openai', PIWI_AI_BASE_URL: 'https://api.openai.com/v1', PIWI_AI_MODEL: 'gpt-5.2' },
  },
  {
    id: 'ai-local',
    label: 'AI diagnosis (local model)',
    hint: 'Ollama or another self-hosted model',
    values: { PIWI_AI_PROVIDER: 'openai', PIWI_AI_BASE_URL: 'http://localhost:11434/v1', PIWI_AI_MODEL: 'qwen3' },
  },
]

const appliedPresets = ref<string[]>([])

function applyPreset(preset: Preset) {
  for (const [name, value] of Object.entries(preset.values)) values[name] = value as string
  if (!appliedPresets.value.includes(preset.id)) appliedPresets.value.push(preset.id)
}

function resetAll() {
  for (const key of Object.keys(values)) delete values[key]
  appliedPresets.value = []
}

// ── Validation ───────────────────────────────────────────────────────────────
const problems = computed(() => {
  const list: Array<{ name: string; message: string }> = []
  for (const name of allNames) {
    const meta = registry[name]
    if (meta.runtimeOnly || !envVarAppliesToVersion(name, serverVersion.value)) continue
    if (meta.requiredWhen && conditionMet(meta.requiredWhen) && !values[name]) {
      list.push({ name, message: `${name} is required when ${conditionLabel(meta.requiredWhen)}.` })
    }
    const raw = values[name]
    if (!raw) continue
    if (meta.type === 'number') {
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) list.push({ name, message: `${name} must be a number.` })
      else if (meta.min !== undefined && parsed < meta.min) list.push({ name, message: `${name} is below the minimum ${meta.min} (the server clamps it up).` })
      else if (meta.max !== undefined && parsed > meta.max) list.push({ name, message: `${name} is above the maximum ${meta.max} (the server clamps it down).` })
    }
    if (meta.type === 'enum' && meta.enum && !(meta.enum as readonly string[]).includes(raw)) {
      list.push({ name, message: `${name} must be one of: ${(meta.enum as readonly string[]).join(', ')}.` })
    }
  }
  return list
})

const problemNames = computed(() => new Set(problems.value.map((problem) => problem.name)))

// ── Output ───────────────────────────────────────────────────────────────────
const entries = computed<EnvEntry[]>(() => {
  const ordered: EnvEntry[] = []
  for (const section of sections.value) {
    for (const name of section.vars) {
      const value = values[name]
      if (!value) continue
      ordered.push({ name, value, secret: registry[name].secret })
    }
  }
  return ordered
})

const activeFormatId = ref(ENV_OUTPUT_FORMATS[0]!.id)
const activeFormat = computed(() => ENV_OUTPUT_FORMATS.find((format) => format.id === activeFormatId.value) ?? ENV_OUTPUT_FORMATS[0]!)

/** One tab row per group, so thirteen formats stay scannable. */
const formatGroups = computed(() =>
  ENV_OUTPUT_GROUPS.map((group) => ({
    group,
    formats: ENV_OUTPUT_FORMATS.filter((format) => format.group === group),
  })).filter((row) => row.formats.length),
)

const output = computed(() => {
  if (!entries.value.length) return ''
  return activeFormat.value.emit(entries.value, {
    image: imageForVersion(serverVersion.value),
    header: [
      'Piwi Dashboard configuration — built with the offline generator',
      `Server ${serverVersion.value} · https://piwitests.dev/configuration`,
    ],
  })
})

const copied = ref(false)
async function copyOutput() {
  await navigator.clipboard.writeText(output.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

function downloadOutput() {
  const blob = new Blob([output.value], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = activeFormat.value.filename
  link.click()
  URL.revokeObjectURL(url)
}

// ── Secrets ──────────────────────────────────────────────────────────────────
const GENERATABLE_SECRETS = new Set<PiwiEnvVarName>(['PIWI_SECRET_KEY', 'PIWI_AUTH_SECRET'])

function generateSecret(name: PiwiEnvVarName) {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  values[name] = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  revealed[name] = false
}

function inputType(name: PiwiEnvVarName, meta: PiwiEnvVarMeta): string {
  if (meta.secret && !revealed[name]) return 'password'
  if (meta.type === 'number') return 'number'
  return 'text'
}

function placeholderFor(meta: PiwiEnvVarMeta): string {
  if (meta.default !== undefined) return `default: ${meta.default}`
  if (meta.example) return `e.g. ${meta.example}`
  return ''
}
</script>

<template>
  <div class="env-wizard">
    <div class="offline-note">
      <strong>🔒 100% offline.</strong> This generator runs entirely in your browser: values you type — including
      secrets — never leave this page. No requests, no analytics, no storage; reloading clears everything. It keeps
      working with the network unplugged.
    </div>

    <section class="wizard-block">
      <div class="block-head">
        <h2 class="block-title">Start from a preset</h2>
        <button v-if="entries.length" class="ghost-button" type="button" @click="resetAll">Reset all</button>
      </div>
      <div class="preset-grid">
        <button
          v-for="preset in PRESETS"
          :key="preset.id"
          type="button"
          class="preset-card"
          :class="{ applied: appliedPresets.includes(preset.id) }"
          @click="applyPreset(preset)"
        >
          <span class="preset-label">{{ preset.label }}</span>
          <span class="preset-hint">{{ preset.hint }}</span>
        </button>
      </div>
      <p class="block-note">
        Presets pre-fill a starting point (they combine). Piwi also runs with <em>zero</em> configuration — only set
        what you want to change.
      </p>
    </section>

    <section v-if="versionOptions.length > 1" class="wizard-block">
      <label class="version-label" for="wizard-server-version">Server version</label>
      <select id="wizard-server-version" v-model="serverVersion" class="wizard-select version-select">
        <option v-for="option in versionOptions" :key="option" :value="option">
          {{ option }}{{ option === currentVersion ? ' (latest)' : '' }}
        </option>
      </select>
      <p class="block-note">Only variables understood by this server version are shown and emitted.</p>
    </section>

    <details
      v-for="section in sections"
      :key="section.category"
      class="wizard-section"
      :open="!section.collapsed"
    >
      <summary>
        <span class="section-title">{{ section.title }}</span>
        <span class="section-count">{{ section.vars.filter((name) => values[name]).length }} set · {{ section.vars.length }} vars</span>
      </summary>
      <p v-if="section.intro" class="section-intro">{{ section.intro }}</p>
      <div class="var-list">
        <div
          v-for="name in section.vars"
          :key="name"
          class="var-row"
          :class="{ invalid: problemNames.has(name) }"
        >
          <label class="var-name" :for="`wizard-${name}`">
            <code>{{ name }}</code>
            <span v-if="registry[name].secret" class="chip chip-secret">secret</span>
            <span v-if="registry[name].since" class="chip">since {{ registry[name].since }}</span>
          </label>
          <div class="var-control">
            <select
              v-if="registry[name].type === 'boolean'"
              :id="`wizard-${name}`"
              v-model="values[name]"
              class="wizard-select"
            >
              <option value="">default{{ registry[name].default !== undefined ? ` (${registry[name].default})` : '' }}</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
            <select
              v-else-if="registry[name].type === 'enum'"
              :id="`wizard-${name}`"
              v-model="values[name]"
              class="wizard-select"
            >
              <option value="">unset{{ registry[name].default !== undefined ? ` (default: ${registry[name].default})` : '' }}</option>
              <option v-for="option in registry[name].enum" :key="option" :value="option">{{ option }}</option>
            </select>
            <template v-else>
              <input
                :id="`wizard-${name}`"
                v-model="values[name]"
                class="wizard-input"
                :type="inputType(name, registry[name])"
                :placeholder="placeholderFor(registry[name])"
                :min="registry[name].min"
                :max="registry[name].max"
                autocomplete="off"
                spellcheck="false"
              />
              <button
                v-if="registry[name].secret"
                type="button"
                class="ghost-button"
                :aria-label="revealed[name] ? `Hide ${name}` : `Show ${name}`"
                @click="revealed[name] = !revealed[name]"
              >
                {{ revealed[name] ? 'Hide' : 'Show' }}
              </button>
              <button
                v-if="GENERATABLE_SECRETS.has(name)"
                type="button"
                class="ghost-button"
                @click="generateSecret(name)"
              >
                Generate
              </button>
            </template>
          </div>
          <p class="var-description">
            {{ registry[name].description }}
            <template v-if="registry[name].notes"> {{ registry[name].notes }}</template>
          </p>
        </div>
      </div>
    </details>

    <section class="wizard-block output-block">
      <div class="block-head">
        <h2 class="block-title">Your configuration</h2>
        <span class="section-count">{{ entries.length }} variable{{ entries.length === 1 ? '' : 's' }} set</span>
      </div>

      <div v-if="problems.length" class="problem-box" role="alert">
        <p v-for="problem in problems" :key="problem.message">⚠ {{ problem.message }}</p>
      </div>

      <div v-if="!entries.length" class="empty-output">
        Nothing set yet — Piwi runs with zero configuration. Pick a preset or set a variable above and the export
        appears here.
      </div>
      <template v-else>
        <div
          v-for="row in formatGroups"
          :key="row.group"
          class="format-tabs"
          role="tablist"
          :aria-label="`Output format — ${row.group}`"
        >
          <span class="format-group-label">{{ row.group }}</span>
          <button
            v-for="format in row.formats"
            :key="format.id"
            type="button"
            role="tab"
            class="format-tab"
            :class="{ active: format.id === activeFormatId }"
            :aria-selected="format.id === activeFormatId"
            @click="activeFormatId = format.id"
          >
            {{ format.label }}
          </button>
        </div>
        <div class="output-actions">
          <button type="button" class="action-button" @click="copyOutput">{{ copied ? 'Copied ✓' : 'Copy' }}</button>
          <button type="button" class="action-button" @click="downloadOutput">Download {{ activeFormat.filename }}</button>
        </div>
        <pre class="output-pre"><code>{{ output }}</code></pre>
      </template>
    </section>
  </div>
</template>

<style scoped>
.env-wizard {
  margin-top: 16px;
}
.offline-note {
  border: 1px solid var(--vp-c-brand-2);
  border-radius: 8px;
  padding: 12px 16px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-text-1);
  font-size: 14px;
  line-height: 1.6;
  margin-bottom: 20px;
}
.wizard-block {
  margin: 20px 0;
}
.block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.block-title {
  margin: 0 0 8px;
  border: none;
  padding: 0;
  font-size: 18px;
  font-weight: 600;
}
.block-note {
  font-size: 13px;
  color: var(--vp-c-text-2);
  margin: 8px 0 0;
}
.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
}
.preset-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s;
}
.preset-card:hover {
  border-color: var(--vp-c-brand-1);
}
.preset-card.applied {
  border-color: var(--vp-c-brand-1);
  outline: 1px solid var(--vp-c-brand-1);
}
.preset-label {
  font-weight: 600;
  font-size: 14px;
}
.preset-hint {
  font-size: 12px;
  color: var(--vp-c-text-2);
}
.wizard-section {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  margin: 12px 0;
  overflow: hidden;
}
.wizard-section summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  cursor: pointer;
  background: var(--vp-c-bg-soft);
  font-weight: 600;
  list-style: none;
}
.wizard-section summary::before {
  content: '▸';
  margin-right: 8px;
  color: var(--vp-c-text-3);
  transition: transform 0.15s;
  display: inline-block;
}
.wizard-section[open] summary::before {
  transform: rotate(90deg);
}
.section-title {
  flex: 1;
}
.section-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--vp-c-text-2);
  white-space: nowrap;
}
.section-intro {
  font-size: 13px;
  color: var(--vp-c-text-2);
  margin: 10px 16px 0;
  line-height: 1.6;
}
.var-list {
  padding: 6px 16px 14px;
}
.var-row {
  padding: 10px 0;
  border-bottom: 1px dashed var(--vp-c-divider);
}
.var-row:last-child {
  border-bottom: none;
}
.var-row.invalid .wizard-input,
.var-row.invalid .wizard-select {
  border-color: var(--vp-c-danger-1);
}
.var-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.var-name code {
  font-size: 13px;
  background: transparent;
  padding: 0;
}
.chip {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
}
.chip-secret {
  border-color: var(--vp-c-warning-2, var(--vp-c-divider));
  color: var(--vp-c-warning-1, var(--vp-c-text-2));
}
.var-control {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.wizard-input,
.wizard-select {
  flex: 1;
  min-width: 220px;
  padding: 6px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 13px;
  font-family: var(--vp-font-family-mono);
}
.wizard-input:focus,
.wizard-select:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
}
.version-select {
  flex: none;
  min-width: 160px;
}
.version-label {
  display: block;
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 6px;
}
.var-description {
  font-size: 12.5px;
  color: var(--vp-c-text-2);
  margin: 6px 0 0;
  line-height: 1.55;
}
.ghost-button {
  padding: 5px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 12px;
  cursor: pointer;
}
.ghost-button:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}
.problem-box {
  border: 1px solid var(--vp-c-danger-1);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
  background: var(--vp-c-danger-soft);
}
.problem-box p {
  margin: 2px 0;
  font-size: 13px;
}
.empty-output {
  border: 1px dashed var(--vp-c-divider);
  border-radius: 8px;
  padding: 18px;
  color: var(--vp-c-text-2);
  font-size: 14px;
  text-align: center;
}
.format-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.format-tabs:last-of-type {
  margin-bottom: 10px;
}
.format-group-label {
  min-width: 96px;
  color: var(--vp-c-text-3);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.format-tab {
  padding: 5px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 12.5px;
  cursor: pointer;
}
.format-tab.active {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  font-weight: 600;
}
.output-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.action-button {
  padding: 6px 14px;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 6px;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white, #fff);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.action-button:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
}
.output-pre {
  margin: 0;
  padding: 14px 16px;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.6;
}
.output-pre code {
  background: transparent;
  padding: 0;
  white-space: pre;
}
</style>
