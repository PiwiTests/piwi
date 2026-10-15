import type { NuxtError } from '#app';
import { capitalize } from '~/utils/bug-reports';

/** What the error page shows when a page's entity does not load. */
export interface PageLoadErrorView {
  /** The HTTP status the page answers with. */
  statusCode: number;
  /** The heading, also the HTTP status text: printable ASCII only. */
  title: string;
  description: string;
}

/**
 * The error page's text for an entity (`'test run'`, `'project'`) whose API
 * answered `statusCode`: 404 when it does not exist or its id is malformed, 403
 * when the viewer holds no role on its project, 401 when the session has ended.
 * Any other failure keeps the API's `detail`.
 */
export function describePageLoadError(
  statusCode: number | undefined,
  entity: string,
  detail?: string,
): PageLoadErrorView {
  switch (statusCode) {
    // The API answers 400 for an id that is not a number.
    case 400:
    case 404:
      return {
        statusCode: 404,
        title: `${capitalize(entity)} not found`,
        description: `This ${entity} does not exist. It may have been deleted, or the link may be wrong.`,
      };
    case 403:
      return {
        statusCode,
        title: `No access to this ${entity}`,
        description:
          entity === 'project'
            ? 'You have no role on this project. An administrator, or a Project admin of this project, can give you one.'
            : `This ${entity} belongs to a project you have no role on. An administrator, or a Project admin of that project, can give you one.`,
      };
    case 401:
      return {
        statusCode,
        title: 'Signed out',
        description: `Your session has ended. Sign in again to open this ${entity}.`,
      };
    default:
      return {
        statusCode: statusCode && statusCode >= 400 ? statusCode : 500,
        title: `Could not load this ${entity}`,
        description: detail || 'The server did not answer. Try again in a moment.',
      };
  }
}

/**
 * Replace a page with `error.vue` when the entity it shows does not load, with
 * the API's status, which the server render answers with:
 *
 * ```ts
 * const { data: run, error } = await useFetch(`/api/test-runs/${id}`);
 * if (error.value) showPageLoadError(error.value, 'test run');
 * ```
 *
 * On the server it throws, which ends the render. In the browser it shows the
 * error page and returns, so the page's setup finishes on empty data and its
 * template never renders without its setup state.
 */
export function showPageLoadError(error: NuxtError, entity: string): void {
  const view = describePageLoadError(
    error.statusCode,
    entity,
    (error.data as { message?: string } | undefined)?.message,
  );
  const pageError = createError({ statusCode: view.statusCode, statusMessage: view.title, message: view.description });
  if (import.meta.server) throw pageError;
  showError(pageError);
}
