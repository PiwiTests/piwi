import type { RetryRunOptions } from '#shared/retry-command';
import { DEFAULT_RETRY_PREFS, parseRetryPrefs, RETRY_PREFS_COOKIE, type RetryPrefs } from '~/utils/retry-prefs';

/**
 * The Copy retry command choices every button of a page shares: the naming
 * mode and the run options, remembered per browser in a cookie read on the
 * server and the client, and the Playwright project, kept for the page only.
 */
export function useRetryOptions() {
  const cookie = useCookie<RetryPrefs>(RETRY_PREFS_COOKIE, {
    maxAge: 31536000,
    sameSite: 'lax',
    path: '/',
    default: () => ({ ...DEFAULT_RETRY_PREFS }),
    decode: (value) => {
      try {
        return parseRetryPrefs(decodeURIComponent(value ?? ''));
      } catch {
        return { ...DEFAULT_RETRY_PREFS };
      }
    },
    encode: (value) => encodeURIComponent(JSON.stringify(value)),
  });
  const prefs = useState<RetryPrefs>('retry-command-prefs', () => parseRetryPrefs(cookie.value));
  const project = useState<string | null>(`retry-command-project:${useRoute().path}`, () => null);

  function update(patch: Partial<RetryPrefs>) {
    prefs.value = parseRetryPrefs({ ...prefs.value, ...patch });
    cookie.value = prefs.value;
  }

  const mode = computed({
    get: () => prefs.value.mode,
    set: (value) => update({ mode: value }),
  });

  /**
   * The run options for a page whose tests ran in `projects`: the chosen project applies only while the menu offers
   * it (two projects or more), and one chosen on another run is left out.
   */
  function optionsFor(projects: readonly string[] = []): RetryRunOptions {
    return {
      runMode: prefs.value.headed ? 'headed' : 'normal',
      trace: prefs.value.trace,
      repeatEach: prefs.value.repeatEach,
      workers: prefs.value.workers,
      project: project.value && projects.length > 1 && projects.includes(project.value) ? project.value : null,
    };
  }

  return { prefs, project, mode, optionsFor, update };
}
