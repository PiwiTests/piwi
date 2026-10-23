<script setup lang="ts">
/**
 * *Export* on the analytics and project pages: the current scope rendered as a
 * quality report, with the built-in report dashboards one click away and a
 * download in every format. The preview and each download come from the same
 * `GET /api/reports/preview`, so what is previewed is what is downloaded.
 */
import { offeredDashboards, type BuiltinDashboardKey } from '#shared/analytics/dashboards';
import type { ReportBundle, ReportFormat } from '#shared/reports/types';
import { REPORT_LANGUAGES, type ReportLanguage } from '#shared/reports/languages';
import { sentencesFor } from '#shared/reports/sentences';

const props = withDefaults(
  defineProps<{
    /** The scope query of the page (the analytics scope keys, `tz`, `locale`). */
    query: Record<string, string>;
    /** Dashboard the preview opens on. */
    dashboard?: BuiltinDashboardKey | string;
    /** The saved dashboard on screen, offered first and rendered as it is. */
    savedDashboard?: { id: string; name: string } | null;
  }>(),
  { dashboard: 'executive', savedDashboard: null },
);

const open = defineModel<boolean>('open', { default: false });

const dashboard = ref<string>(props.savedDashboard?.id ?? props.dashboard);
const language = ref<'auto' | ReportLanguage>('auto');

const { isHidden } = await useInstanceCapabilities();
const dashboardItems = computed(() => [
  ...(props.savedDashboard
    ? [{ label: props.savedDashboard.name, value: props.savedDashboard.id, description: 'This dashboard' }]
    : []),
  ...offeredDashboards({ hasOwner: !!props.query.owner, testMapHidden: isHidden('test-map') }).map((d) => ({
    label: d.name,
    value: d.key as string,
    description: d.description,
  })),
]);
// Each report language under its own name.
const languageItems = [
  { label: 'Default language', value: 'auto' },
  ...REPORT_LANGUAGES.map((code) => ({ label: sentencesFor(code).name, value: code })),
];

const requestQuery = computed(() => ({
  ...props.query,
  dashboard: dashboard.value,
  ...(language.value === 'auto' ? {} : { lang: language.value }),
}));

const {
  data: bundle,
  pending,
  error,
  refresh,
} = useFetch<ReportBundle>('/api/reports/preview', {
  query: requestQuery,
  immediate: false,
  server: false,
  watch: false,
});

watch(
  [open, requestQuery],
  ([isOpen]) => {
    if (isOpen) void refresh();
  },
  { immediate: true },
);

const { download } = useDesktopDownload();
const base = computed(() => (useRuntimeConfig().app?.baseURL ?? '/').replace(/\/$/, ''));

const FORMATS: Array<{ format: ReportFormat; label: string; icon: string }> = [
  { format: 'pdf', label: 'PDF', icon: 'i-lucide-file-text' },
  { format: 'html', label: 'HTML', icon: 'i-lucide-file-code' },
  { format: 'md', label: 'Markdown', icon: 'i-lucide-file-type' },
  { format: 'xlsx', label: 'Excel', icon: 'i-lucide-sheet' },
  { format: 'json', label: 'JSON', icon: 'i-lucide-braces' },
];

async function downloadAs(format: ReportFormat) {
  const params = new URLSearchParams({ ...requestQuery.value, format });
  const day = new Date().toISOString().slice(0, 10);
  await download(
    `${base.value}/api/reports/preview?${params}`,
    `piwi-quality-report-${dashboard.value}-${day}.${format}`,
    {
      binary: format === 'pdf' || format === 'xlsx',
    },
  );
}

const downloadItems = computed(() => [
  FORMATS.map((f) => ({ label: f.label, icon: f.icon, onSelect: () => downloadAs(f.format) })),
]);
</script>

<template>
  <ClientOnly>
    <UModal
      v-model:open="open"
      title="Quality report"
      description="The current scope as a document for readers who do not open the dashboard."
      :ui="{ content: 'sm:max-w-4xl' }"
    >
      <template #body>
        <div class="space-y-4" data-testid="report-preview" data-tour="report-preview">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
            <USelect
              v-model="dashboard"
              :items="dashboardItems"
              class="w-full sm:w-48"
              aria-label="Report dashboard"
              data-testid="report-dashboard"
            />
            <USelect
              v-model="language"
              :items="languageItems"
              class="w-full sm:w-44"
              aria-label="Report language"
              data-testid="report-language"
            />
            <HelpHint topic="reports.export" />
          </div>

          <LoadingState v-if="pending && !bundle" />
          <ErrorState v-else-if="error" :text="`Couldn't build the quality report: ${errorMessage(error)}`">
            <template #action>
              <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
                Retry
              </UButton>
            </template>
          </ErrorState>
          <ReportView v-else-if="bundle" :bundle="bundle" :class="pending ? 'opacity-60' : ''" />
        </div>
      </template>

      <template #footer>
        <div class="flex w-full items-center justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Close" @click="open = false" />
          <UDropdownMenu :items="downloadItems" :content="{ align: 'end' }">
            <UButton
              color="primary"
              icon="i-lucide-download"
              trailing-icon="i-lucide-chevron-down"
              data-testid="report-download"
              data-tour="report-download"
            >
              Download
            </UButton>
          </UDropdownMenu>
        </div>
      </template>
    </UModal>
  </ClientOnly>
</template>
