<script setup lang="ts">
import type { ApiResponse } from '~~/types/api';

const props = defineProps<{
  /**
   * API path of the offline-report endpoint, e.g. `/api/failure-clusters/12/export`.
   * Omit it (as on the run page) to offer only the Perfetto trace.
   */
  endpoint?: string;
  /** API path of the Perfetto trace endpoint, e.g. `/api/test-runs/12/perfetto`. */
  perfettoEndpoint?: string;
  /**
   * API path of a failed execution's bug report, `/api/test-run-cases/12`: offers its `.piwibug` (`/piwibug`) for
   * Piwi Picker's Replay and its steps (`/replay-steps`) to copy, with how many steps Replay leaves to a person.
   */
  replayEndpoint?: string;
  /** Used only for the desktop shell's fallback filename; the server names the file. */
  baseName: string;
}>();

const { download } = useDesktopDownload();
const { copy } = useCopy();
const toast = useToast();
const open = ref(false);
const busy = ref('');

/**
 * These URLs are opened or fetched directly rather than going through `$fetch`,
 * so the app's base path has to be applied by hand — the demo is served from
 * `/demo/` and its service worker only intercepts requests under that prefix. A
 * root-relative `/api/...` would escape the scope entirely and 404.
 */
const base = computed(() => (useRuntimeConfig().app?.baseURL ?? '/').replace(/\/$/, ''));

function withBase(path: string): string {
  return `${base.value}${path}`;
}

async function run(format: 'html' | 'zip' | 'pdf' | 'json' | 'md') {
  open.value = false;
  // ZIP and PDF are the binary formats; the rest are text the shell writes directly.
  await download(withBase(`${props.endpoint}?format=${format}`), `${props.baseName}.${format}`, {
    binary: format === 'zip' || format === 'pdf',
  });
}

/** The Perfetto trace is a JSON file that opens at ui.perfetto.dev. */
async function runPerfetto() {
  open.value = false;
  if (!props.perfettoEndpoint) return;
  await download(withBase(props.perfettoEndpoint), `${props.baseName}-perfetto.json`, { binary: false });
}

/**
 * The clipboard actions read the same endpoints the downloads do, so copying
 * and downloading can never describe the investigation differently.
 */
async function copyFrom(path: string, label: string, pick?: (text: string) => string) {
  busy.value = label;
  try {
    const response = await fetch(withBase(path));
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const text = await response.text();
    copy(pick ? pick(text) : text, { toast: `${label} copied` });
    open.value = false;
  } catch (error) {
    toast.add({ title: `Could not copy ${label.toLowerCase()}`, description: errorMessage(error), color: 'error' });
  } finally {
    busy.value = '';
  }
}

function copyReport() {
  return copyFrom(`${props.endpoint}?format=md`, 'Report');
}

type ReplaySteps = ApiResponse<typeof import('~~/server/api/test-run-cases/[id]/replay-steps.get').default>;

/** The replay summary, read the first time the menu opens. */
const replay = ref<ReplaySteps | null>(null);
const replayFailed = ref(false);
watch(open, async (isOpen) => {
  if (!isOpen || !props.replayEndpoint || replay.value) return;
  replayFailed.value = false;
  try {
    replay.value = await $fetch<ReplaySteps>(`${props.replayEndpoint}/replay-steps`);
  } catch {
    replayFailed.value = true;
  }
});

/** `12 steps · 2 by hand · 3 not replayed`, under the download. */
const replayLine = computed(() => {
  const r = replay.value;
  if (!r) return replayFailed.value ? 'Could not read the steps' : 'Reading the steps…';
  const parts = [`${r.stepCount} ${r.stepCount === 1 ? 'step' : 'steps'}`];
  if (r.manualSteps > 0) parts.push(`${r.manualSteps} by hand`);
  if (r.notReplayed > 0) parts.push(`${r.notReplayed} not replayed`);
  return parts.join(' · ');
});

/** What the steps leave out, listed in the download's tooltip. */
const replayTitle = computed(() => {
  const lines = ['A .piwibug for Piwi Picker’s Replay: plays the steps to the failure in your own browser.'];
  const notes = replay.value?.notes ?? [];
  if (notes.length > 0) lines.push('', 'Not replayed:', ...notes.slice(0, 8).map((n) => `• ${n.title}: ${n.reason}`));
  if (notes.length > 8) lines.push(`• and ${notes.length - 8} more, listed in bug-report.md`);
  return lines.join('\n');
});

async function runReplay() {
  open.value = false;
  if (!props.replayEndpoint) return;
  await download(withBase(`${props.replayEndpoint}/piwibug`), `${props.baseName}.piwibug`, { binary: true });
}

async function copySteps() {
  if (!props.replayEndpoint) return;
  await copyFrom(`${props.replayEndpoint}/replay-steps`, 'Steps', (text) => {
    const steps = (JSON.parse(text) as ReplaySteps).steps;
    return `${JSON.stringify(steps, null, 2)}\n`;
  });
}
</script>

<template>
  <UPopover v-model:open="open">
    <UButton
      icon="i-lucide-share"
      size="xs"
      color="neutral"
      variant="outline"
      title="Take this investigation away"
      aria-label="Export"
    >
      <span class="hidden xl:inline">Export</span>
    </UButton>

    <template #content>
      <div class="w-64 p-1 space-y-0.5">
        <template v-if="endpoint">
          <div class="flex items-center justify-between px-2 pt-1 pb-1">
            <p class="text-xs font-medium text-gray-500">Download</p>
            <HelpHint topic="export.offline" />
          </div>

          <UButton
            block
            size="sm"
            color="neutral"
            variant="ghost"
            class="justify-start"
            icon="i-lucide-file-code"
            title="One self-contained HTML file with screenshots and video embedded"
            @click="run('html')"
          >
            HTML — single file
          </UButton>

          <UButton
            block
            size="sm"
            color="neutral"
            variant="ghost"
            class="justify-start"
            icon="i-lucide-file-archive"
            title="Report plus the raw artifacts, including trace archives and data.json"
            @click="run('zip')"
          >
            ZIP — with all evidence
          </UButton>

          <UButton
            block
            size="sm"
            color="neutral"
            variant="ghost"
            class="justify-start"
            icon="i-lucide-file-down"
            title="A formatted PDF with screenshots embedded — generated directly, no browser print needed"
            @click="run('pdf')"
          >
            PDF — formatted document
          </UButton>

          <UButton
            block
            size="sm"
            color="neutral"
            variant="ghost"
            class="justify-start"
            icon="i-lucide-file-text"
            title="The Markdown report as a file"
            @click="run('md')"
          >
            Markdown
          </UButton>

          <UButton
            block
            size="sm"
            color="neutral"
            variant="ghost"
            class="justify-start"
            icon="i-lucide-file-json"
            title="Everything the report contains, machine-readable"
            @click="run('json')"
          >
            JSON
          </UButton>
        </template>

        <template v-if="replayEndpoint">
          <USeparator class="my-1" />
          <div class="flex items-center justify-between px-2 pt-1 pb-1">
            <p class="text-xs font-medium text-gray-500">Replay in a browser</p>
            <HelpHint topic="export.replay" />
          </div>

          <UButton
            block
            size="sm"
            color="neutral"
            variant="ghost"
            class="justify-start"
            icon="i-lucide-bug-play"
            :title="replayTitle"
            data-testid="export-piwibug"
            @click="runReplay"
          >
            <span class="flex flex-col items-start text-left leading-tight">
              Bug report (.piwibug)
              <span class="text-xs text-gray-500" data-testid="export-piwibug-summary">{{ replayLine }}</span>
            </span>
          </UButton>
        </template>

        <template v-if="perfettoEndpoint">
          <USeparator v-if="endpoint || replayEndpoint" class="my-1" />
          <p class="text-xs font-medium text-gray-500 px-2 pt-1 pb-1">Timeline</p>

          <UButton
            block
            size="sm"
            color="neutral"
            variant="ghost"
            class="justify-start"
            icon="i-lucide-activity"
            title="A Trace Event Format file — opens at ui.perfetto.dev or chrome://tracing"
            @click="runPerfetto"
          >
            <span class="flex flex-col items-start text-left leading-tight">
              Perfetto trace
              <span class="text-xs text-gray-500">Opens at ui.perfetto.dev</span>
            </span>
          </UButton>
        </template>

        <template v-if="endpoint">
          <USeparator class="my-1" />
          <p class="text-xs font-medium text-gray-500 px-2 pt-1 pb-1">Copy to clipboard</p>

          <UButton
            block
            size="sm"
            color="neutral"
            variant="ghost"
            class="justify-start"
            icon="i-lucide-clipboard-list"
            :loading="busy === 'Report'"
            title="The whole investigation as Markdown, for an issue or a chat"
            @click="copyReport"
          >
            Report (Markdown)
          </UButton>

          <UButton
            v-if="replayEndpoint"
            block
            size="sm"
            color="neutral"
            variant="ghost"
            class="justify-start"
            icon="i-lucide-list-checks"
            :loading="busy === 'Steps'"
            title="The steps.json of the bug report, to paste into Piwi Picker’s Replay"
            @click="copySteps"
          >
            Steps (steps.json)
          </UButton>
        </template>
      </div>
    </template>
  </UPopover>
</template>
