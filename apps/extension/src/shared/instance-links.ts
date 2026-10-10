/**
 * Links into the dashboard of the connected instance. Pure: content scripts
 * build their links here, and nothing in this module reaches the network.
 */

/** The instance address as every link and request starts with it: trimmed, without a trailing slash. */
export function normalizeBaseUrl(instanceUrl: string): string {
  return instanceUrl.trim().replace(/\/+$/, '');
}

/** Deep link to a project's "Test functions" catalog page in the dashboard — used by `test-function-panel.ts`'s "Manage catalog" link. */
export function projectCatalogUrl(instanceUrl: string, projectId: number): string {
  return `${normalizeBaseUrl(instanceUrl)}/projects/${projectId}/test-functions`;
}

/**
 * Deep link to a project's Locators page, with locators to check prefilled one
 * per line, on `branch` (null for the default branch, `*` for every branch).
 */
export function projectLocatorsUrl(
  instanceUrl: string,
  projectId: number,
  locators: string[] = [],
  branch: string | null = null,
  page: string | null = null,
): string {
  const base = `${normalizeBaseUrl(instanceUrl)}/projects/${projectId}/locators`;
  const query = [
    ...(locators.length ? [`q=${encodeURIComponent(locators.join('\n'))}`] : []),
    ...(branch ? [`branch=${encodeURIComponent(branch)}`] : []),
    ...(page ? [`page=${encodeURIComponent(page)}`] : []),
  ];
  return query.length ? `${base}?${query.join('&')}` : base;
}

/** Deep link to a test case's page in the dashboard. */
export function testCaseUrl(instanceUrl: string, testCaseId: number): string {
  return `${normalizeBaseUrl(instanceUrl)}/test-cases/${testCaseId}`;
}

/** Deep link to a bug report's page in the dashboard. */
export function bugReportUrl(instanceUrl: string, id: number): string {
  return `${normalizeBaseUrl(instanceUrl)}/bug-reports/${id}`;
}

/**
 * Whether `pageUrl` is one of the instance's own pages: the same origin and,
 * when the instance address has a path, under it (`https://tools.example/piwi`
 * covers `/piwi` and `/piwi/projects`, never `/piwi-old`).
 */
export function isInstancePage(instanceUrl: string, pageUrl: string): boolean {
  let instance: URL;
  let page: URL;
  try {
    instance = new URL(normalizeBaseUrl(instanceUrl));
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (instance.protocol !== 'http:' && instance.protocol !== 'https:') return false;
  if (instance.origin !== page.origin) return false;
  const path = instance.pathname.replace(/\/+$/, '');
  return path === '' || page.pathname === path || page.pathname.startsWith(`${path}/`);
}
