import { stopCopy, tourCopyFor, type TourCopy } from '~/utils/demo-tour/copy';
import { DEFAULT_TOUR_LANGUAGE, pickTourLanguage, type TourLanguage } from '~/utils/demo-tour/languages';
import { TOUR_PROFILES } from '~/utils/demo-tour/profiles';
import { readTourPromptState, TOUR_PROMPT_STORAGE_KEY, type TourPromptState } from '~/utils/demo-tour/prompt-state';
import type { TourProfile, TourProfileId } from '~/utils/demo-tour/types';
import type { GuideRun } from '~/utils/guide/types';

/** A key of the tour's own words, the `ui` block of the copy files. */
type TourUiKey = keyof TourCopy['ui'];

function readStoredState(): TourPromptState {
  try {
    return readTourPromptState(localStorage.getItem(TOUR_PROMPT_STORAGE_KEY));
  } catch {
    return {};
  }
}

/** Merges `patch` into the stored state. */
function remember(patch: TourPromptState): void {
  try {
    localStorage.setItem(TOUR_PROMPT_STORAGE_KEY, JSON.stringify({ ...readStoredState(), ...patch }));
  } catch {
    // No storage (private browsing, blocked site data): the choice lasts for this visit.
  }
}

/** The stored tour language, else the first tour language the browser prefers. */
function preferredTourLanguage(): TourLanguage {
  const stored = readStoredState().language;
  if (stored) return stored;
  return pickTourLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** A role's tour as the guide engine runs it, in `language`: its stops with their copy, and the tour's own words. */
function tourGuide(profile: TourProfile, language: TourLanguage, onFinish: () => void): GuideRun {
  const { next, back, done, close, docs, progress } = tourCopyFor(language).ui;
  return {
    id: `demo-tour-${profile.id}`,
    lang: language,
    stops: profile.stops.map((stop) => {
      const words = stopCopy(language, profile.id, stop.id);
      return {
        id: stop.id,
        anchor: stop.anchor,
        route: stop.route,
        title: words?.title ?? '',
        body: words?.body ?? '',
        doc: stop.doc,
        side: stop.side,
        align: stop.align,
      };
    }),
    words: { next, back, done, close, docs, progress },
    dataset: { tourProfile: profile.id },
    onFinish,
  };
}

/**
 * The demo's guided tour: the prompt's state, what the browser decided about it
 * (`localStorage['piwi-demo-tour']`), the tour language, and starting a role's
 * tour, which the guide engine (`useGuide`) runs across the pages of its stops.
 */
export function useDemoTour() {
  const toast = useToast();
  const guide = useGuide();

  const language = useState<TourLanguage>('demo-tour-language', () =>
    import.meta.client ? preferredTourLanguage() : DEFAULT_TOUR_LANGUAGE,
  );
  const promptOpen = useState('demo-tour-prompt-open', () => false);

  const copy = computed(() => tourCopyFor(language.value));

  /** One of the tour's own words, in the tour language. */
  function t(key: TourUiKey): string {
    return copy.value.ui[key];
  }

  /** Takes the stored language, or the browser's; the server renders in English. */
  function restoreLanguage(): void {
    language.value = preferredTourLanguage();
  }

  function setLanguage(next: TourLanguage): void {
    language.value = next;
    remember({ language: next });
  }

  /** Shows the prompt, ending a running tour. */
  function openPrompt(): void {
    guide.stop();
    promptOpen.value = true;
  }

  /** **Later**: closes the prompt, which opens by itself again on a visit a day later. */
  function snooze(): void {
    promptOpen.value = false;
    remember({ decision: 'snoozed', decidedAt: Date.now() });
  }

  /** **×**: closes the prompt for good; the banner button still opens it. */
  function dismiss(): void {
    promptOpen.value = false;
    remember({ decision: 'dismissed', decidedAt: Date.now() });
  }

  /** **Done** on the last stop: says where the other tours are. */
  function finished(tourLanguage: TourLanguage): void {
    const words = tourCopyFor(tourLanguage).ui;
    toast.add({
      title: words.finishedTitle,
      description: words.finishedBody,
      color: 'neutral',
      icon: 'i-lucide-compass',
    });
  }

  /** Starts a role's tour at its first stop. */
  async function start(profileId: TourProfileId): Promise<void> {
    const profile = TOUR_PROFILES.find((p) => p.id === profileId);
    if (import.meta.server || !profile) return;
    promptOpen.value = false;
    remember({ decision: 'started', decidedAt: Date.now() });
    const tourLanguage = language.value;
    await guide.start(tourGuide(profile, tourLanguage, () => finished(tourLanguage)));
  }

  return {
    language: readonly(language),
    promptOpen: readonly(promptOpen),
    isRunning: guide.isRunning,
    copy,
    t,
    restoreLanguage,
    setLanguage,
    openPrompt,
    snooze,
    dismiss,
    start,
    stop: guide.stop,
    /** What this browser decided about the prompt, from `localStorage`. */
    storedState: readStoredState,
  };
}
