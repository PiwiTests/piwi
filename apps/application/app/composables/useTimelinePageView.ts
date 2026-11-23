import { PAGE_VIEWS, parsePageView, type PageView } from '~/utils/timeline-frames';

const COOKIE = 'piwi-timeline-page-view';
const ONE_YEAR_S = 60 * 60 * 24 * 365;

/**
 * How the failure timeline's list shows the page (`PAGE_VIEWS`): a per-browser
 * preference kept in a cookie for a year. The side panel, the default, stores
 * nothing.
 */
export function useTimelinePageView() {
  const cookie = useCookie<string | null>(COOKIE, { default: () => null, maxAge: ONE_YEAR_S, sameSite: 'lax' });
  return computed<PageView>({
    get: () => parsePageView(cookie.value),
    set: (view) => (cookie.value = view === PAGE_VIEWS[0] ? null : view),
  });
}
