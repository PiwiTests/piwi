import { runnerRunDuration, type RunnerRun, type RunnerRunStatus } from '~/utils/runner-runs';

type RunnerStatusKey =
  | 'runner_statusRunning'
  | 'runner_statusPassed'
  | 'runner_statusFailed'
  | 'runner_statusStopped'
  | 'runner_statusError';
type RunnerTone = 'primary' | 'success' | 'error' | 'neutral';

/** Each status's words, tone and icon. */
const STATUS: Record<RunnerRunStatus, { label: RunnerStatusKey; tone: RunnerTone; icon: string }> = {
  running: { label: 'runner_statusRunning', tone: 'primary', icon: 'i-lucide-loader-circle' },
  passed: { label: 'runner_statusPassed', tone: 'success', icon: 'i-lucide-circle-check' },
  failed: { label: 'runner_statusFailed', tone: 'error', icon: 'i-lucide-circle-x' },
  stopped: { label: 'runner_statusStopped', tone: 'neutral', icon: 'i-lucide-circle-stop' },
  error: { label: 'runner_statusError', tone: 'error', icon: 'i-lucide-triangle-alert' },
};

/** The round mark of each tone, and its text color. */
const TONE_MARKS: Record<RunnerTone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  error: 'bg-error/10 text-error',
  neutral: 'bg-elevated text-muted',
};
const TONE_TEXTS: Record<RunnerTone, string> = {
  primary: 'text-primary',
  success: 'text-success',
  error: 'text-error',
  neutral: 'text-muted',
};

/**
 * What the window says of a run, on its line in the list and on the run shown: its status (words, icon, colors), its
 * name (its test's title, else how many tests), how long it took (`duration`, counting each second while a run of the
 * window goes on), and its details: its project, when it started and how long it took.
 */
export function useRunnerRunView() {
  const words = useRunUiWords();
  const { t } = useRunnerWords();
  const { info } = useRunnerLanguage();
  const { runs } = useRunnerRuns();

  function status(run: RunnerRun) {
    const shown = STATUS[run.status];
    return {
      ...shown,
      words: run.stopRequested && run.status === 'running' ? t('runner_stopping') : t(shown.label),
      mark: TONE_MARKS[shown.tone],
      text: TONE_TEXTS[shown.tone],
    };
  }

  function name(run: RunnerRun): string {
    if (run.tests.length === 1) return run.tests[0]!.title;
    return run.tests.length ? words.tn('runui_tests', run.tests.length) : run.title;
  }

  const { now, pause, resume } = useNow({ interval: 1000, controls: true });
  watch(
    () => runs.value.some((run) => run.status === 'running'),
    (on) => (on ? resume() : pause()),
    { immediate: true },
  );

  const clock = computed(
    () => new Intl.DateTimeFormat(runnerLanguageTag(info.value.language), { hour: 'numeric', minute: '2-digit' }),
  );

  function duration(run: RunnerRun): string {
    const seconds = Math.floor(runnerRunDuration(run, now.value.getTime()) / 1000);
    return seconds < 60
      ? words.t('runui_durationSeconds', { seconds: words.number(seconds) })
      : words.t('runui_durationMinutes', { minutes: words.number(Math.floor(seconds / 60)), seconds: seconds % 60 });
  }

  /** Its project, when it started and how long it took, to join with ` · `. */
  function details(run: RunnerRun): string[] {
    return [run.projectName, t('runner_startedAt', { time: clock.value.format(run.startedAt) }), duration(run)].filter(
      (part): part is string => !!part,
    );
  }

  return { status, name, duration, details };
}
