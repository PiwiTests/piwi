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
 * What a run's card and row say of it: its status (words, icon, colors), its name (its test's title, else how many
 * tests), and its project, when it started and how long it took, counting each second while it runs.
 */
export function useRunnerRunView(run: () => RunnerRun) {
  const words = useRunUiWords();
  const { t } = useRunnerWords();
  const { info } = useRunnerLanguage();

  const status = computed(() => {
    const shown = STATUS[run().status];
    return {
      ...shown,
      words: run().stopRequested && run().status === 'running' ? t('runner_stopping') : t(shown.label),
      mark: TONE_MARKS[shown.tone],
      text: TONE_TEXTS[shown.tone],
    };
  });

  const name = computed(() => {
    const tests = run().tests;
    if (tests.length === 1) return tests[0]!.title;
    return tests.length ? words.tn('runui_tests', tests.length) : run().title;
  });

  const { now, pause, resume } = useNow({ interval: 1000, controls: true });
  watch(
    () => run().status === 'running',
    (on) => (on ? resume() : pause()),
    { immediate: true },
  );

  const clock = computed(
    () => new Intl.DateTimeFormat(runnerLanguageTag(info.value.language), { hour: 'numeric', minute: '2-digit' }),
  );

  function durationWords(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    return seconds < 60
      ? words.t('runui_durationSeconds', { seconds: words.number(seconds) })
      : words.t('runui_durationMinutes', { minutes: words.number(Math.floor(seconds / 60)), seconds: seconds % 60 });
  }

  /** Its project, when it started and how long it took, to join with ` · `. */
  const details = computed(() =>
    [
      run().projectName,
      t('runner_startedAt', { time: clock.value.format(run().startedAt) }),
      durationWords(runnerRunDuration(run(), now.value.getTime())),
    ].filter((part): part is string => !!part),
  );

  return { status, name, details };
}
