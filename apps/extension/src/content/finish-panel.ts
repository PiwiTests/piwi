import { normalizeSteps, sessionFromEvents, stepViews } from '@piwitests/core/recording';
import { renderSpec } from '@piwitests/core/codegen';
import { sessionFromSteps } from '@piwitests/core/steps';
import {
  BUG_REPORT_EXTENSION,
  BUG_REPORT_MEDIA_TYPE,
  isWrongStep,
  summarizeEvidence,
} from '@piwitests/core/bug-report';
import {
  assembleBugReport,
  bugReportArchive,
  bugReportMarkdown,
  stepShotsOf,
  withoutStepShots,
} from './bug-report-files.js';
import {
  PANEL_CSS,
  currentBugContext,
  input,
  keptStepViews,
  reportLanguage,
  screenshotNoteText,
  stepRow,
} from './bug-panel.js';
import { openSendPreview, SEND_DIALOG_HOST_ID, sendTarget } from './bug-send-panel.js';
import { FRAME_HOST_ID, HUD_HOST_ID, PANEL_HOST_ID, copyToClipboard, fileStamp, startReplayHere } from './record-ui.js';
import { attachPanelShadow } from './panel-root.js';
import { recordingSpec } from '../shared/recording-spec.js';
import { codegenWarningText, interfacePhrases } from '../shared/core-words.js';
import { getBugEvidence, getBugScreenshots } from '../shared/bug-storage.js';
import { downloadBlob } from '../shared/download.js';
import { makeButton, type ButtonOptions } from '../shared/buttons.js';
import { formatNumber, t, tn, uiLanguage } from '../shared/i18n.js';
import { updateRecording, type RecordingState } from '../shared/recording-storage.js';
import { cleanTitle, RECORDING_TITLE_MAX, titleFromSteps } from '../shared/recording-title.js';
import { getConnectionSettings } from '../shared/connection-settings.js';
import { getActiveProjectOverride, resolveActiveProject } from '../shared/active-project.js';
import { getCachedCatalog } from '../shared/catalog-cache.js';
import { requestCatalogRefresh } from '../shared/catalog-refresh.js';
import { getEditorPairing } from '../shared/editor-pairing.js';
import { sendToEditor, showSendResult } from '../shared/editor-send.js';

/** How long after the last keystroke the finish panel stores its title. */
const TITLE_WRITE_MS = 300;

interface TitleWriter {
  /** Stores `title` once {@link TITLE_WRITE_MS} pass without another. */
  schedule(title: string): void;
  /** Stores the pending title now; resolves once no write is in flight. */
  flush(): Promise<void>;
  /** Forgets the pending title; resolves once no write is in flight. */
  drop(): Promise<void>;
}

/** The finish panel's title, stored on the recording the panel shows and on no other (see `updateRecording`). */
function titleWriter(startedAt: number | null): TitleWriter {
  let pending: { title: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<unknown> = Promise.resolve();
  const cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  const idle = (): Promise<void> => writing.then(() => undefined);
  const flush = (): Promise<void> => {
    cancel();
    if (pending) {
      const { title } = pending;
      pending = null;
      writing = writing.then(() => updateRecording(startedAt, { title })).catch(() => undefined);
    }
    return idle();
  };
  return {
    schedule(title) {
      pending = { title };
      cancel();
      timer = setTimeout(() => void flush(), TITLE_WRITE_MS);
    },
    flush,
    drop() {
      cancel();
      pending = null;
      return idle();
    },
  };
}

/**
 * The finished recording: its title, its steps with what was marked wrong and
 * the test functions they match, the evidence, and the exports. A recording
 * with a step that says the page was wrong is a bug report, and its test is
 * the failing one; without one, its test passes. Send to Piwi…, when an
 * instance is connected, shows exactly what would be sent before anything is.
 */
export async function renderFinishPanel(state: RecordingState, onDiscard: () => Promise<void>): Promise<void> {
  document.getElementById(HUD_HOST_ID)?.remove();
  document.getElementById(PANEL_HOST_ID)?.remove();
  // The recording is over: the border goes first, so it never outlives the capture it signals.
  document.getElementById(FRAME_HOST_ID)?.remove();

  const [evidence, screenshots, views, connection, override] = await Promise.all([
    getBugEvidence(),
    getBugScreenshots(),
    keptStepViews(state.events),
    getConnectionSettings(),
    getActiveProjectOverride(),
  ]);
  const context = evidence.context ?? (await currentBugContext());
  // Worth waiting for here: the copied test is written against the catalog, and one that predates a function added
  // meanwhile would leave raw locators where a call belonged.
  const activeProject = resolveActiveProject(connection, override, location.href);
  await requestCatalogRefresh(activeProject?.projectId ?? null);
  const catalog = await getCachedCatalog(activeProject?.projectId ?? null);

  const startedAt = state.startedAt ?? state.events[0]?.timestamp ?? Date.now();
  const fallbackTitle = titleFromSteps(normalizeSteps(state.events));
  const titles = titleWriter(state.startedAt);
  let typedTitle = state.title ?? '';
  const title = (): string | null => cleanTitle(typedTitle) ?? fallbackTitle;
  /** The reporter keeps the step screenshots unless they leave them out. */
  let keepStepShots = true;
  const report = () => {
    const assembled = assembleBugReport({
      events: state.events,
      startedAt,
      evidence: { ...evidence, title: title() },
      screenshots,
      context,
      views,
    });
    return keepStepShots ? assembled : withoutStepShots(assembled);
  };
  const initial = report();
  const steps = initial.steps.steps;
  const wrong = steps.some(isWrongStep);
  const matched = renderSpec(sessionFromSteps(initial.steps), { catalog }).matchedSpans;
  const stepImages = new Map(
    stepShotsOf(sessionFromEvents(state.events, startedAt).steps, views).map(({ shot, dataUrl }) => [
      shot.file,
      dataUrl,
    ]),
  );

  const host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('record_reviewLabel'));
  panel.lang = uiLanguage();
  panel.tabIndex = -1;

  // Every close path (the ×, the backdrop, Discard, Escape, a replay started) stores the title still pending and
  // detaches the document-level listeners with the panel.
  const controller = new AbortController();
  const closePanel = (): void => {
    void titles.flush();
    controller.abort();
    host.remove();
  };

  const header = document.createElement('div');
  header.className = 'header';
  const heading = document.createElement('div');
  const headingTitle = document.createElement('div');
  headingTitle.className = 'title';
  headingTitle.textContent = wrong ? tn('bug_finishTitle', steps.length) : tn('record_stepsRecorded', steps.length);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent =
    matched.length > 0
      ? tn('record_stepsMatched', matched.length)
      : catalog.length > 0
        ? t('record_noFunctionMatches')
        : t('record_notConnected');
  heading.append(headingTitle, sub);
  const closeBtn = makeButton(t('common_close'), closePanel, {
    icon: 'close',
    iconOnly: true,
    tone: 'ghost',
    className: 'close',
  });
  header.append(heading, closeBtn);
  panel.appendChild(header);

  const titleLabel = document.createElement('label');
  titleLabel.textContent = t('bug_title');
  titleLabel.htmlFor = 'recording-title';
  const titleInput = input(typedTitle, fallbackTitle ?? t('bug_titlePlaceholder'));
  titleInput.id = 'recording-title';
  titleInput.maxLength = RECORDING_TITLE_MAX;
  titleInput.addEventListener('input', () => {
    typedTitle = titleInput.value;
    titles.schedule(titleInput.value);
  });
  panel.append(titleLabel, titleInput);

  const stepsWrap = document.createElement('div');
  stepsWrap.className = 'steps';
  steps.forEach((step, i) => {
    const row = stepRow(step, i);
    const span = matched.find((s) => i >= s.startStep && i <= s.endStep);
    if (span) {
      const badge = document.createElement('span');
      badge.className = 'step-fn';
      badge.textContent = span.functionName;
      row.appendChild(badge);
    }
    stepsWrap.appendChild(row);
  });
  panel.appendChild(stepsWrap);

  const summary = document.createElement('div');
  summary.className = 'evidence';
  const summarize = () => t('bug_attached', { summary: summarizeEvidence(report().evidence, interfacePhrases()) });
  summary.textContent = summarize();
  panel.appendChild(summary);

  if (stepImages.size > 0) {
    const keep = document.createElement('label');
    keep.className = 'keep';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      keepStepShots = box.checked;
      summary.textContent = summarize();
    });
    keep.append(box, t('bug_stepShots', { count: formatNumber(stepImages.size) }));
    const hint = document.createElement('div');
    hint.className = 'evidence';
    hint.textContent = t('bug_stepShotsHint');
    panel.append(keep, hint);
  }

  const notes: string[] = [];
  for (const w of recordingSpec(initial, catalog).warnings)
    notes.push(t('bug_stepWarning', { step: w.step + 1, message: codegenWarningText(w) }));
  // A bug report says why it has no screenshot; a recording that marks nothing wrong needs none.
  if (wrong && initial.evidence.screenshots.length === 0) {
    notes.push(
      evidence.screenshotNote
        ? t('bug_noScreenshot', { reason: screenshotNoteText(evidence.screenshotNote) })
        : t('bug_noScreenshotTaken'),
    );
  }
  for (const text of notes) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = text;
    panel.appendChild(warn);
  }

  const message = document.createElement('div');
  message.className = 'warn';
  message.setAttribute('role', 'alert');
  const row = (): HTMLDivElement => {
    const actions = document.createElement('div');
    actions.className = 'actions';
    panel.appendChild(actions);
    return actions;
  };
  const action = (
    into: HTMLElement,
    label: string,
    options: ButtonOptions,
    onClick: (btn: HTMLButtonElement) => void,
  ): HTMLButtonElement => {
    const b: HTMLButtonElement = makeButton(label, () => onClick(b), options);
    into.appendChild(b);
    return b;
  };

  // The test: copied, sent to the editor, or played again here.
  const testActions = row();
  action(
    testActions,
    wrong ? t('bug_copyTest') : t('record_copyTest'),
    { icon: 'code', tone: 'primary', title: wrong ? t('bug_copyTestHint') : t('record_copyTestHint') },
    (b) => {
      void titles.flush();
      void copyToClipboard(recordingSpec(report(), catalog).code, b);
    },
  );
  if (matched.length > 0) {
    action(
      testActions,
      t('record_copyWithoutFunctions'),
      { icon: 'copy', title: t('record_copyWithoutFunctionsHint') },
      (b) => {
        void titles.flush();
        void copyToClipboard(recordingSpec(report()).code, b);
      },
    );
  }
  if (await getEditorPairing().catch(() => null)) {
    action(testActions, t('record_sendToEditor'), { icon: 'send' }, (b) => {
      void titles.flush();
      void sendToEditor({ kind: 'steps', steps: report().steps }).then((result) => showSendResult(b, result));
    });
  }
  action(
    testActions,
    t('record_replay'),
    { icon: 'play', title: wrong ? t('bug_replayHint') : t('record_replayHint') },
    (b) => {
      b.disabled = true;
      void (async () => {
        await titles.flush();
        // The replay shows a step it hands to the person as the recording saw it.
        const response = await startReplayHere(
          report().steps,
          stepViews(sessionFromEvents(state.events, startedAt).steps),
        );
        if (response.ok) closePanel();
        else {
          b.disabled = false;
          message.textContent = response.error ?? t('common_replayStartFailed');
        }
      })();
    },
  );

  // The report: its Markdown, its file, and the instance.
  const reportActions = row();
  action(reportActions, t('bug_copyReport'), { icon: 'copy', title: t('bug_copyReportHint') }, (b) => {
    void copyToClipboard(bugReportMarkdown(report(), reportLanguage()), b);
  });
  action(reportActions, t('bug_downloadReport'), { icon: 'download', title: t('bug_downloadReportHint') }, () => {
    void titles.flush();
    const current = report();
    downloadBlob(
      new Blob([bugReportArchive(current, screenshots, reportLanguage(), stepImages) as BlobPart], {
        type: BUG_REPORT_MEDIA_TYPE,
      }),
      `piwi-${wrong ? 'bug' : 'recording'}-${fileStamp(current.context.time)}.${BUG_REPORT_EXTENSION}`,
    );
  });
  const sendBtn = action(reportActions, t('bug_sendToPiwi'), { icon: 'send', title: t('bug_sendToPiwiHint') }, () => {
    void sendTarget().then((target) => {
      if (!target.project) {
        message.textContent = t('bug_sendNoProject');
        return;
      }
      openSendPreview({
        report: report(),
        screenshots,
        stepImages,
        target: { ...target, project: target.project },
        css: PANEL_CSS,
      });
    });
  });
  sendBtn.hidden = true;
  action(reportActions, t('common_discard'), { icon: 'trash', tone: 'remove', className: 'discard' }, () => {
    void titles.drop().then(onDiscard).then(closePanel, closePanel);
  });
  panel.appendChild(message);

  const local = document.createElement('div');
  local.className = 'local';
  local.textContent = t('bug_staysLocal');
  panel.appendChild(local);
  void sendTarget().then((target) => {
    if (!target.connected) return;
    sendBtn.hidden = false;
    local.textContent = t('bug_staysLocalUntilSent');
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closePanel();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && !document.getElementById(SEND_DIALOG_HOST_ID)) closePanel();
    },
    { capture: true, signal: controller.signal },
  );
  window.addEventListener('pagehide', () => void titles.flush(), { signal: controller.signal });

  backdrop.appendChild(panel);
  root.append(style, backdrop);
  panel.focus();
}
