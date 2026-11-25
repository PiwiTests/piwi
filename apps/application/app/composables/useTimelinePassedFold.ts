const COOKIE = 'piwi-timeline-passed';
const ONE_YEAR_S = 60 * 60 * 24 * 365;

/**
 * Whether the failure timeline's list folds the rows that passed before the
 * failure under one Passed row (`passedRowsToFold`): folded by default, a
 * per-browser choice kept in a cookie for a year, which stores only the choice
 * to show them.
 */
export function useTimelinePassedFold() {
  const cookie = useCookie<string | null>(COOKIE, { default: () => null, maxAge: ONE_YEAR_S, sameSite: 'lax' });
  return computed<boolean>({
    get: () => cookie.value !== 'shown',
    set: (folded) => (cookie.value = folded ? null : 'shown'),
  });
}
