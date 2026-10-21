<script setup lang="ts">
/**
 * *Preview* in the schedule form: the report the schedule would send now,
 * over its last complete cadence (the period *Run now* reports on), without
 * saving anything. *Email* is the message exactly as the server renders it,
 * the chart drawn from the same marks; *Full report* is the report every
 * delivery is kept as on the Reports page, where *Open in Piwi* leads.
 */
import { chartMarksSvg } from '#shared/reports/chart';
import { makeFormatter } from '#shared/reports/format';
import { BRAND_MARK_DATA_URL } from '#shared/brand';
import { EMAIL_CHART, emailTrendBlock, renderReportEmail } from '#shared/reports/render-email';
import type { ReportSchedulePreview } from '#shared/handlers/reports';

const props = defineProps<{
  /** The preview request: the form's values, without the channels. */
  request: Record<string, unknown>;
  /** The channels the schedule sends to. */
  channels: Array<{ name: string; type: string }>;
  /** What the report is compared with, mid-sentence ("the previous period"); null for no comparison. */
  comparison: string | null;
  includeShareLink: boolean;
  includeNarrative: boolean;
}>();

const preview = ref<ReportSchedulePreview | null>(null);
const pending = ref(false);
const error = ref<unknown>(null);

async function load() {
  pending.value = true;
  error.value = null;
  try {
    preview.value = await $fetch<ReportSchedulePreview>('/api/reports/schedules/preview', {
      method: 'POST',
      body: props.request,
    });
  } catch (e) {
    error.value = e;
  } finally {
    pending.value = false;
  }
}
watch(() => props.request, load, { immediate: true, deep: true });

const isEmail = (type: string) => type === 'email' || type === 'personal_email';
/** No channel picked yet reads as email, the message most schedules send. */
const sendsEmail = computed(() => props.channels.length === 0 || props.channels.some((c) => isEmail(c.type)));

const view = ref<'email' | 'report'>(sendsEmail.value ? 'email' : 'report');
watch(sendsEmail, (email) => {
  if (!email) view.value = 'report';
});
const viewItems = computed(() => [
  ...(sendsEmail.value ? [{ label: 'Email', value: 'email', icon: 'i-lucide-mail' }] : []),
  { label: 'Full report', value: 'report', icon: 'i-lucide-file-text' },
]);

const siteUrl = computed(() => preview.value?.siteUrl ?? window.location.origin);

/** The whole days the report covers, in the viewer's locale. */
const periodText = computed(() => {
  const period = preview.value?.period;
  if (!period) return '';
  const f = makeFormatter('en', viewerLocale());
  return `${f.date(period.from)} to ${f.date(period.to)}`;
});

/** The email as the server renders it, the chart's marks inline instead of attached. */
const email = computed(() => {
  const bundle = preview.value?.bundle;
  if (!bundle) return null;
  const trend = emailTrendBlock(bundle);
  const chartSrc = trend
    ? `data:image/svg+xml;base64,${btoa(chartMarksSvg(trend, EMAIL_CHART.width, EMAIL_CHART.height))}`
    : null;
  const rendered = renderReportEmail(bundle, {
    url: `${siteUrl.value}/reports`,
    chartSrc,
    shareUrl: props.includeShareLink ? `${siteUrl.value}/share` : null,
    siteUrl: siteUrl.value,
    markSrc: BRAND_MARK_DATA_URL,
  });
  // A picture of the message: its links go nowhere from here.
  return {
    subject: rendered.subject,
    html: rendered.html.replace('</head>', '<style>a{pointer-events:none}</style></head>'),
  };
});

// The frame takes the height of the message, so the dialog scrolls as one page. Narrower than
// the message, it shrinks it to fit, as a phone's mail app does with a fixed-width email.
const EMAIL_FRAME_WIDTH = 600;
const frameBox = ref<HTMLElement | null>(null);
const { width: boxWidth } = useElementSize(frameBox);
const frameScale = computed(() => (boxWidth.value > 0 ? Math.min(1, boxWidth.value / EMAIL_FRAME_WIDTH) : 1));
const frame = ref<HTMLIFrameElement | null>(null);
const frameHeight = ref(900);
function fitFrame() {
  const height = frame.value?.contentDocument?.documentElement.scrollHeight;
  if (height) frameHeight.value = height;
}

/** What each kind of channel receives, for the channels this schedule sends to. */
const deliveries = computed(() => {
  const names = new Map<string, string[]>();
  for (const c of props.channels) {
    const kind = isEmail(c.type) ? 'email' : c.type;
    names.set(kind, [...(names.get(kind) ?? []), c.name]);
  }
  const what: Record<string, string> = {
    email: 'this email',
    slack: 'a Slack message with the verdict, the headline numbers, the trend and what changed',
    teams: 'the same content as a Microsoft Teams card',
    webhook: 'the full report as JSON',
    browser: 'a notification that opens the full report',
  };
  return [...names].map(([kind, list]) => ({ kind, names: list.join(', '), what: what[kind] ?? 'the report' }));
});
</script>

<template>
  <div class="space-y-4" data-testid="schedule-preview">
    <LoadingState v-if="pending && !preview" />
    <ErrorState v-else-if="error" :text="`Couldn't build the preview: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="load()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <template v-else-if="preview">
      <div class="space-y-1 text-sm">
        <p class="text-highlighted" data-testid="schedule-preview-period">
          As it would be sent now: {{ periodText
          }}<template v-if="comparison">, compared with {{ comparison }}</template
          >.
        </p>
        <ul v-if="deliveries.length > 0" class="text-xs text-muted space-y-0.5">
          <li v-for="d in deliveries" :key="d.kind">
            <span class="font-medium text-default">{{ d.names }}</span
            >: {{ d.what }}.
          </li>
        </ul>
        <p class="text-xs text-muted">Each report is also kept on the Reports page, as the full report.</p>
        <p v-if="includeNarrative" class="text-xs text-muted">
          The AI narrative is written when each report is sent; the preview keeps the rule-based verdict in its place.
        </p>
      </div>

      <div v-if="viewItems.length > 1" class="flex">
        <UTabs
          v-model="view"
          :items="viewItems"
          size="xs"
          :content="false"
          :ui="{ list: 'overflow-x-auto', trigger: 'shrink-0' }"
          data-testid="schedule-preview-view"
        />
      </div>

      <div v-if="view === 'email' && email" :class="pending ? 'opacity-60' : ''">
        <p class="mb-2 text-xs text-muted">
          Subject: <span class="text-default" data-testid="schedule-preview-subject">{{ email.subject }}</span>
        </p>
        <div
          ref="frameBox"
          class="overflow-hidden rounded border border-default"
          :style="{ height: `${Math.ceil(frameHeight * frameScale)}px` }"
          data-shot="schedule-preview-email"
        >
          <iframe
            ref="frame"
            :srcdoc="email.html"
            sandbox="allow-same-origin"
            title="The email as sent"
            class="block origin-top-left"
            :style="
              frameScale < 1
                ? { width: `${EMAIL_FRAME_WIDTH}px`, height: `${frameHeight}px`, transform: `scale(${frameScale})` }
                : { width: '100%', height: `${frameHeight}px` }
            "
            data-testid="schedule-preview-email"
            @load="fitFrame"
          />
        </div>
      </div>
      <ReportView v-else :bundle="preview.bundle" :class="pending ? 'opacity-60' : ''" />
    </template>
  </div>
</template>
