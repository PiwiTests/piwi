<script setup lang="ts">
/**
 * Who uses this locator? Three readings of one chain, each a question the
 * index answers from recorded steps:
 * - this locator: the exact chain;
 * - same target: any chain ending on the same call, inside any container;
 * - inside a container: every chain that searches inside one of its containers,
 *   for a change to the container itself.
 * Call sites shared by the most tests come first — a page-object line is one
 * fix for all of them. The tests found can be turned into a run command.
 * Answers in the view of one branch (`branch`: a name, `*` for every branch,
 * the default branch when absent).
 */
import type { ExecutionLocatorUse, LocatorUsageMatch, LocatorUsagesResult } from '#shared/locator-usages.types';
import { assessLocator, stabilityLabels } from '#shared/locator-stability';
import { formatPageList } from '~/utils/locator-pages';

const props = defineProps<{
  open: boolean;
  use: ExecutionLocatorUse | null;
  projectId: number | null;
  projectKey?: string | number;
  projectName?: string;
  branch?: string | null;
}>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();

interface Reading {
  id: string;
  label: string;
  match: LocatorUsageMatch;
  value: string;
  hint: string;
}

const readings = computed<Reading[]>(() => {
  const use = props.use;
  if (!use) return [];
  const list: Reading[] = [
    {
      id: 'locator',
      label: 'This locator',
      match: 'locator',
      value: use.locator,
      hint: 'Tests whose steps used this exact chain.',
    },
  ];
  if (use.target !== use.locator) {
    list.push({
      id: 'target',
      label: 'Same target',
      match: 'target',
      value: use.target,
      hint: `Chains ending on ${use.target}, inside any container.`,
    });
  }
  use.scopes.forEach((scope, i) => {
    list.push({
      id: `scope-${i}`,
      label: use.scopes.length > 1 ? `Inside container ${i + 1}` : 'Inside its container',
      match: 'scope',
      value: scope,
      hint: `Every chain that searches inside ${scope}. A change to that container reaches all of them.`,
    });
  });
  return list;
});

/** Why the chain may break on an unrelated change, from the locator stability rules; null when stable. */
const stability = computed(() => {
  const s = props.use ? assessLocator(props.use.locator) : null;
  if (!s || s.level === 'stable') return null;
  return {
    text: `${s.level === 'brittle' ? 'Brittle' : 'Watch'}: ${stabilityLabels(s, ', ')}`,
    detail: s.findings.map((f) => f.detail).join('\n'),
  };
});

const readingId = ref('locator');
const reading = computed(() => readings.value.find((r) => r.id === readingId.value) ?? readings.value[0] ?? null);

watch(
  () => props.use,
  () => {
    readingId.value = 'locator';
    command.value = null;
  },
);

const result = ref<LocatorUsagesResult | null>(null);
const pending = ref(false);
const failed = ref(false);

watch(
  () => [props.open, props.projectId, reading.value?.match, reading.value?.value, props.branch] as const,
  async ([open, projectId], _old, onCleanup) => {
    const r = reading.value;
    if (!open || !projectId || !r) return;
    // Switching readings quickly must not let a slower, older answer win.
    let stale = false;
    onCleanup(() => (stale = true));
    pending.value = true;
    failed.value = false;
    command.value = null;
    try {
      const found = await $fetch<LocatorUsagesResult>(`/api/projects/${projectId}/locator-usages`, {
        query: { match: r.match, value: r.value, ...(props.branch ? { branch: props.branch } : {}) },
      });
      if (!stale) {
        result.value = found;
        command.value = null;
      }
    } catch {
      if (!stale) {
        failed.value = true;
        result.value = null;
      }
    } finally {
      if (!stale) pending.value = false;
    }
  },
  { immediate: true },
);

const TESTS_SHOWN = 5;
const expanded = ref(new Set<string>());
const siteKey = (callSite: string | null, locator: string) => `${callSite ?? ''}|${locator}`;

const testIds = computed(() => {
  const ids = new Set<number>();
  for (const site of result.value?.sites ?? []) for (const t of site.tests) ids.add(t.testCaseId);
  return [...ids];
});

// ── Run these tests ─────────────────────────────────────────────────────
const command = ref<string | null>(null);
const commandPending = ref(false);
const { command: withVariables } = useProjectRunVariables(() => props.projectId);
const toast = useToast();

async function buildCommand() {
  if (!props.projectId || testIds.value.length === 0) return;
  // The command belongs to the result it was built from; a newer result drops it.
  const forResult = result.value;
  commandPending.value = true;
  try {
    const resolved = await $fetch<{ materialization: { command: string } }>(
      `/api/projects/${props.projectId}/selections/preview`,
      { method: 'POST', body: { definition: { include: [{ ids: testIds.value }] }, format: 'args' } },
    );
    if (result.value === forResult) command.value = resolved.materialization.command || null;
  } catch {
    if (result.value === forResult) toast.add({ title: 'Could not build the run command', color: 'error' });
  } finally {
    commandPending.value = false;
  }
}
</script>

<template>
  <USlideover
    :open="open"
    title="Who uses this?"
    :ui="{ content: 'max-w-2xl' }"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div v-if="use" class="space-y-4" data-shot="locator-usage-drawer">
        <div class="space-y-1">
          <p class="text-xs font-medium text-muted">{{ locatorActionLabel(use.action) }}</p>
          <LocatorCode :locator="use.locator" class="text-sm" />
          <p v-if="stability" class="text-xs text-muted" data-stability :title="stability.detail">
            {{ stability.text }} ·
            <DocLink to="reference/locator-stability" no-icon :class="SENTENCE_LINK_CLASS">why</DocLink>
          </p>
        </div>

        <div
          v-if="readings.length > 1"
          class="flex flex-wrap gap-1 rounded-md bg-elevated/60 p-0.5 w-fit max-w-full"
          role="group"
          aria-label="Which locators to match"
        >
          <button
            v-for="r in readings"
            :key="r.id"
            type="button"
            class="rounded px-2.5 py-1 text-sm outline-none focus-visible:outline-2 focus-visible:outline-primary transition-colors"
            :class="readingId === r.id ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'"
            :aria-pressed="readingId === r.id ? 'true' : 'false'"
            @click="readingId = r.id"
          >
            {{ r.label }}
          </button>
        </div>
        <p v-if="reading" class="text-sm text-highlighted leading-relaxed break-words">{{ reading.hint }}</p>

        <LoadingState v-if="pending" text="Finding the tests…" />
        <ErrorState v-else-if="failed" text="Could not load the tests that use this locator." />
        <template v-else-if="result">
          <p class="text-xs text-muted">
            <span class="tabular-nums">{{ result.testCount }}</span>
            {{ result.testCount === 1 ? 'test' : 'tests' }} ·
            <span class="tabular-nums">{{ result.sites.length }}</span>
            {{ result.sites.length === 1 ? 'call site' : 'call sites' }} ·
            <template v-if="result.branch">on <BranchLabel :name="result.branch" /></template>
            <template v-else>on every branch</template>
            <template v-if="result.truncated"> · showing the most recent matches</template>
          </p>

          <ul class="divide-y divide-default border-y border-default">
            <li v-for="site in result.sites" :key="siteKey(site.callSite, site.locator)" class="py-3 space-y-1.5">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                <OpenInIdeLink
                  v-if="site.callSite"
                  :location="site.callSite"
                  :project-key="projectKey"
                  :project-name="projectName"
                />
                <span v-else>Unknown call site</span>
                <span>{{ site.actions.map(locatorActionLabel).join(', ') }}</span>
                <span v-if="site.pages?.length" data-pages :title="site.pages.join('\n')"
                  >on {{ formatPageList(site.pages) }}</span
                >
              </div>
              <LocatorCode v-if="site.locator !== reading?.value" :locator="site.locator" class="text-sm" />
              <ul class="text-sm space-y-0.5">
                <li
                  v-for="t in expanded.has(siteKey(site.callSite, site.locator))
                    ? site.tests
                    : site.tests.slice(0, TESTS_SHOWN)"
                  :key="t.testCaseId"
                  class="min-w-0 truncate"
                >
                  <NuxtLink :to="`/test-cases/${t.testCaseId}`" :class="SENTENCE_LINK_CLASS" :title="t.filePath">
                    {{ t.suitePath ? `${t.suitePath} › ${t.title}` : t.title }}
                  </NuxtLink>
                </li>
              </ul>
              <button
                v-if="site.tests.length > TESTS_SHOWN && !expanded.has(siteKey(site.callSite, site.locator))"
                type="button"
                class="text-xs text-muted"
                :class="SENTENCE_LINK_CLASS"
                @click="expanded.add(siteKey(site.callSite, site.locator))"
              >
                {{ site.tests.length - TESTS_SHOWN }} more
              </button>
            </li>
          </ul>

          <div v-if="result.testCount > 0" class="space-y-2">
            <UButton v-if="!command" color="primary" :loading="commandPending" @click="buildCommand">
              Run these {{ result.testCount }} {{ result.testCount === 1 ? 'test' : 'tests' }}
            </UButton>
            <template v-else>
              <p class="text-xs font-medium text-muted">Run them</p>
              <CodeBlock :code="withVariables(command)" lang="bash" />
            </template>
          </div>
        </template>
      </div>
    </template>
  </USlideover>
</template>
