import { test, expect, type Page } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import type { CiDispatchView } from '#shared/ci-dispatches';
import { ciTagsArgs } from '#shared/ci-tags';
import { waitForHydration } from './utils';

/**
 * Tests tagged… in the project page's run dialog: the project's tags to pick from (a tag no grep can name left out, the
 * spellings of one tag as one), any or all of them, the actions that take tagged tests, what Send asks the server for,
 * and the dialog of a project whose actions take tagged tests and no whole suite. A dispatch the provider
 * took cannot be made on the test server (its CI actions reach no CI), so the send and the page's reads of the
 * project's dispatches are answered in the browser; the dispatch itself is the server's, covered by its unit tests.
 */
test.describe.serial('Run dialog, tagged tests', () => {
  let projectId: number;

  /** A Jenkins action of the project, on a base URL that resolves to this machine: offered, and never sent. */
  const jenkins = (id: string, name: string, accepts: string[]) => ({
    id,
    name,
    target: { type: 'ci-server', preset: 'jenkins', baseUrl: 'https://localhost:9/', fields: { job: id } },
    inputs: [],
    accepts,
  });

  test.beforeAll(async ({ request }) => {
    const testCase = (title: string, line: number, tags: string[]) => ({
      title,
      status: 'passed',
      duration: 1000,
      location: `tests/shop.spec.ts:${line}:5`,
      tags,
    });
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_DIALOG_TAGS,
        status: 'passed',
        startTime: new Date(Date.now() - 60_000).toISOString(),
        duration: 4000,
        totalTests: 5,
        passedTests: 5,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          testCase('signs in', 3, ['@smoke']),
          testCase('pays by card', 12, ['@smoke', '@checkout']),
          testCase('exports a report', 30, ['@slow']),
          testCase('costs $5', 44, ['@price$']),
          testCase('signs out', 50, ['@Smoke']),
        ],
      },
    });
    expect(res.ok(), `submit failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    ({ projectId } = (await res.json()) as { projectId: number });
    const saved = await request.patch(`/api/projects/${projectId}`, {
      data: {
        ciRerun: {
          enabled: true,
          actions: [jenkins('smoke', 'Smoke', ['suite']), jenkins('nightly', 'Nightly', ['suite', 'tags'])],
          defaults: { suite: 'smoke', tags: 'nightly' },
        },
      },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
  });

  /** The dispatch the page sends, answered as the provider would take it, and the project's open dispatches. */
  async function answerDispatches(page: Page) {
    const bodies: unknown[] = [];
    let open: CiDispatchView[] = [];
    await page.route(
      (url) => url.pathname === `/api/projects/${projectId}/ci-dispatches`,
      async (route) => {
        if (route.request().method() !== 'POST') return route.fulfill({ json: { items: open } });
        const body = route.request().postDataJSON() as { source: { tags: string[]; match?: 'any' | 'all' } };
        bodies.push(body);
        const sent: CiDispatchView = {
          id: '00000000feedbeef',
          actionId: 'nightly',
          actionName: 'Nightly',
          kind: 'tags',
          origin: 'page',
          provider: 'ci-server',
          preset: 'jenkins',
          url: 'https://jenkins.example.com/job/nightly/',
          args: ciTagsArgs(body.source.tags, body.source.match ?? 'any'),
          ref: null,
          tests: null,
          state: 'dispatched',
          detail: null,
          runId: null,
          run: null,
          at: Date.now(),
          byName: null,
          byUserId: null,
        };
        open = [sent];
        return route.fulfill({ status: 201, json: sent });
      },
    );
    return bodies;
  }

  test('picks the project’s tags, any or all of them, and sends them to the action that takes them', async ({
    page,
  }) => {
    const bodies = await answerDispatches(page);
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run on CI' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { name: 'The whole suite' })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /^Smoke/ })).toBeChecked();
    await expect(dialog.getByTestId('run-dialog-tags')).toHaveCount(0);

    await dialog.getByRole('radio', { name: 'Tests tagged…' }).click();
    const tags = dialog.getByTestId('run-dialog-tags');
    await expect(tags).toContainText('Pick up to 10 tags');
    await expect(dialog.getByRole('radio', { name: /^Nightly/ })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /^Smoke/ })).toBeDisabled();
    await expect(dialog.getByTestId('run-dialog-ci')).toContainText('Does not take tagged tests.');
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();

    await tags.getByRole('button', { name: 'Tags' }).click();
    const options = page.getByRole('listbox').getByRole('option');
    await expect(options).toHaveText([/@smoke\s*3 tests/, /@checkout\s*1 test/, /@slow\s*1 test/]);
    await options.filter({ hasText: '@smoke' }).click();
    await options.filter({ hasText: '@checkout' }).click();
    await page.keyboard.press('Escape');
    await expect(tags).toContainText('CI runs the tests tagged @smoke or @checkout, through one --grep.');
    await tags.getByRole('radio', { name: 'All of them' }).click();
    await expect(tags).toContainText('CI runs the tests tagged @smoke and @checkout, through one --grep.');

    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(dialog.getByTestId('run-follow-up-state')).toContainText('waiting for the run to report');
    expect(bodies).toEqual([{ source: { tags: ['smoke', 'checkout'], match: 'all' }, action: 'nightly' }]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const row = page.locator('[data-shot="runs-table"]').getByTestId('waiting-dispatch');
    await expect(row).toContainText('Tagged @smoke and @checkout · Nightly');
  });

  test('the server answers what a dispatch of tagged tests may name', async ({ request }) => {
    const offered = await request.get(`/api/projects/${projectId}/ci-actions/offered?tags=`);
    expect(await offered.json()).toMatchObject({ kind: 'tags', defaultActionId: 'nightly' });
    const none = await request.post(`/api/projects/${projectId}/ci-dispatches`, { data: { source: { tags: [] } } });
    expect(none.status()).toBe(400);
    expect(await none.text()).toContain('A dispatch of tagged tests names at least one tag.');
    const unsafe = await request.post(`/api/projects/${projectId}/ci-dispatches`, {
      data: { source: { tags: ['price$'] } },
    });
    expect(unsafe.status()).toBe(400);
    expect(await unsafe.text()).toContain('cannot be sent to CI');
  });

  test('opens on tagged tests where no action takes the whole suite, and says why no tag can be picked', async ({
    page,
    request,
  }) => {
    const saved = await request.patch(`/api/projects/${projectId}`, {
      data: {
        ciRerun: { enabled: true, actions: [jenkins('nightly', 'Nightly', ['tags'])], defaults: { tags: 'nightly' } },
      },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run on CI' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { name: 'Tests tagged…' })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /^Nightly/ })).toBeChecked();
    await expect(dialog.getByTestId('run-dialog-tags').getByRole('button', { name: 'Tags' })).toBeVisible();

    // Every tag of the project refused: the dialog says why, not that the tests carry none.
    await page.route(
      (url) => url.pathname === `/api/projects/${projectId}/test-cases/facets`,
      (route) => route.fulfill({ json: { values: { tag: [{ value: 'price$', count: 1 }] } } }),
    );
    await page.reload();
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run on CI' }).first().click();
    await expect(dialog.getByTestId('run-dialog-no-tags')).toContainText(
      "None of this project's tags can be sent to CI",
    );
  });
});
