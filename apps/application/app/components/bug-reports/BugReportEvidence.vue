<script setup lang="ts">
/**
 * What the reporter sent along with the steps: screenshots, the page as each
 * step began, console errors and warnings, requests that failed, and the
 * outline of the page (built by the extension in the YAML form of an ARIA
 * snapshot; not Playwright's snapshot).
 */
import { describeStepInParts, type BugScreenshot, type StepPart } from '@piwitests/core/bug-report';
import type { ViewportBox } from '@piwitests/core/recording';
import type { BugReportDetail } from '#shared/handlers/bug-reports';
import type { LightboxImage, LightboxSubject } from '~/utils/lightbox';

const props = defineProps<{ report: BugReportDetail }>();
const baseURL = useRuntimeConfig().app.baseURL;

const evidence = computed(() => props.report.evidence);
const screenshotUrl = (index: number) => `${baseURL}api/bug-reports/${props.report.id}/screenshots/${index}`;
const stepShots = computed(() => evidence.value.stepShots ?? []);
const stepShotUrl = (step: number) => `${baseURL}api/bug-reports/${props.report.id}/step-shots/${step}`;
const stepParts = (step: number): StepPart[] => {
  const recorded = props.report.steps.steps[step];
  return recorded ? describeStepInParts(recorded) : [];
};
/** A step in plain words, for a frame's name in the lightbox. */
const stepWords = (step: number) =>
  stepParts(step)
    .map((part) => part.text)
    .join('');
function momentLabel(moment: BugScreenshot['moment']): string {
  if (moment === 'marked') return 'When a step was marked';
  if (moment === 'finish') return 'At the end';
  return 'Taken by hand';
}

// Every screenshot, then every step's, in one lightbox: a frame's index there is
// its place in this list. Each names the step it was taken at.
const lightboxImages = computed<LightboxImage[]>(() => [
  ...evidence.value.screenshots.map((shot, i) => ({
    src: screenshotUrl(i),
    name: `Screenshot ${i + 1}: ${momentLabel(shot.moment)}`,
    step: shot.step != null ? `After step ${shot.step + 1}: ${stepWords(shot.step)}` : null,
  })),
  ...stepShots.value.map((shot) => ({
    src: stepShotUrl(shot.step),
    name: `The page as step ${shot.step + 1} began`,
    step: `Step ${shot.step + 1}: ${stepWords(shot.step)}`,
  })),
]);
const lightboxSubject = computed<LightboxSubject | null>(() =>
  props.report.test
    ? {
        title: props.report.test.title,
        location: props.report.test.filePath,
        projectKey: props.report.projectId,
        projectName: props.report.projectName,
      }
    : null,
);
const lightboxIndex = ref<number | null>(null);

/** Where the step's element was on its screenshot, as percentages of the viewport it shows. */
function markStyle(box: ViewportBox | null, viewport: { width: number; height: number } | null) {
  if (!box || !viewport || box.width <= 0 || box.height <= 0) return null;
  const pct = (n: number, of: number) => `${Math.max(0, Math.min(100, (n / of) * 100))}%`;
  return {
    left: pct(box.x, viewport.width),
    top: pct(box.y, viewport.height),
    width: pct(box.width, viewport.width),
    height: pct(box.height, viewport.height),
  };
}
const nothing = computed(
  () =>
    evidence.value.screenshots.length === 0 &&
    stepShots.value.length === 0 &&
    evidence.value.console.length === 0 &&
    evidence.value.requests.length === 0 &&
    !evidence.value.outline,
);
</script>

<template>
  <div class="space-y-4" data-shot="bug-report-evidence">
    <EmptyState v-if="nothing" icon="i-lucide-paperclip" text="The reporter sent no evidence with this report." />

    <SectionCard v-if="evidence.screenshots.length" title="Screenshots" :count="evidence.screenshots.length">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <figure v-for="(shot, i) in evidence.screenshots" :key="shot.file" class="space-y-1">
          <ZoomableImage
            :src="screenshotUrl(i)"
            :alt="`Screenshot ${i + 1}`"
            img-class="max-h-64 w-full object-contain object-top"
            frame-class="rounded border border-default bg-muted"
            @open="lightboxIndex = i"
          />
          <figcaption class="text-xs text-muted">
            {{ momentLabel(shot.moment) }}
            <template v-if="shot.step != null"> · after step {{ shot.step + 1 }}</template>
          </figcaption>
        </figure>
      </div>
    </SectionCard>
    <p v-else-if="evidence.screenshotNote" class="text-xs text-muted">No screenshot: {{ evidence.screenshotNote }}.</p>

    <SectionCard
      v-if="stepShots.length"
      title="Screenshot of each step"
      :count="stepShots.length"
      data-shot="bug-report-step-shots"
    >
      <template #subtitle>The page as each step began, its element outlined.</template>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <figure v-for="(shot, i) in stepShots" :key="shot.file" class="space-y-1">
          <ZoomableImage
            :src="stepShotUrl(shot.step)"
            :alt="`The page as step ${shot.step + 1} began`"
            img-class="h-auto w-full"
            frame-class="rounded bg-muted"
            @open="lightboxIndex = evidence.screenshots.length + i"
          >
            <div
              v-if="markStyle(shot.box, shot.viewport)"
              class="pointer-events-none absolute rounded-sm border-2 border-amber-500"
              :style="markStyle(shot.box, shot.viewport)!"
            />
          </ZoomableImage>
          <figcaption class="text-xs text-muted">
            <span class="text-highlighted">Step {{ shot.step + 1 }}</span> ·
            <BugStepText :parts="stepParts(shot.step)" />
          </figcaption>
        </figure>
      </div>
    </SectionCard>

    <SectionCard
      v-if="evidence.requests.length"
      title="Failed requests"
      :count="evidence.requests.length + evidence.requestsDropped"
    >
      <ul class="space-y-1 text-sm">
        <li v-for="(r, i) in evidence.requests" :key="i" class="flex flex-wrap gap-x-2 font-mono text-xs">
          <span class="text-highlighted">{{ r.method }} {{ r.url }}</span>
          <span class="text-muted">{{ r.status ? `answered ${r.status}` : 'no answer' }} · on {{ r.page }}</span>
        </li>
      </ul>
    </SectionCard>

    <SectionCard
      v-if="evidence.console.length"
      title="Console errors and warnings"
      :count="evidence.console.length + evidence.consoleDropped"
    >
      <ul class="space-y-1.5">
        <li v-for="(c, i) in evidence.console" :key="i" class="text-xs">
          <span class="text-muted">{{ c.level === 'warn' ? 'Warning' : 'Error' }} on {{ c.page }}</span>
          <ErrorText :text="c.message" mode="block" />
        </li>
      </ul>
    </SectionCard>

    <SectionCard v-if="evidence.outline" title="Page outline">
      <template #subtitle>Built by Piwi Picker from the page, in the form of an ARIA snapshot.</template>
      <pre class="max-h-96 overflow-auto rounded bg-muted p-3 font-mono text-xs text-highlighted">{{
        evidence.outline
      }}</pre>
    </SectionCard>

    <ScreenshotLightbox v-model="lightboxIndex" :images="lightboxImages" :subject="lightboxSubject" />
  </div>
</template>
