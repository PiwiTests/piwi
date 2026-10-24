import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

/**
 * The lab's scenarios: what a person does on the Piwi dashboard, written with
 * Playwright's trusted input and a person's pace. Each one is recorded by the
 * extension, then replayed by it and by Playwright (see `README.md`).
 *
 * Keep them repeatable: a scenario may type into a form and cancel it, or set
 * a filter, but not save anything a second run would find changed.
 */

export interface Scenario {
  name: string;
  /** The route the recording starts on, or the full URL of a site of its own (`wild.ts`). */
  start: string;
  run: (page: Page) => Promise<void>;
  /** `bug` records it as Report a bug does; `actions` (the default) as Record actions does. */
  mode?: 'actions' | 'bug';
  /** How long a person looks at the first page before acting, when it differs from `LAB_SETTLE_MS`. */
  settleMs?: number;
  /**
   * What the person types, in order, where the replay hands over a field whose
   * value the recording never keeps (a password).
   */
  secrets?: string[];
  /**
   * What the extension cannot replay yet, for a scenario kept to show it. The
   * lab reports the result without failing on it.
   */
  knownGap?: string;
  /** How many hover steps the recording must hold: the hovers its clicks depend on, and no others. */
  hovers?: number;
}

export const pause = (page: Page, ms = 900) => page.waitForTimeout(ms);

/** A file of that name in the lab's `out/files/`, for a scenario that chooses one. */
export function labFile(name: string): string {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'files');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, 'PK');
  return file;
}

export async function type(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 70 });
}

/** Clicks a field, selects what it holds and types over it, as a person does. */
export async function retype(page: Page, field: ReturnType<Page['getByRole']>, text: string): Promise<void> {
  await field.click();
  await page.keyboard.press('ControlOrMeta+A');
  await type(page, text);
}

/** Clicks the n-th entry of whatever list a popup just opened: options, menu items or checkboxes. */
export async function pickInPopup(page: Page, n = 0): Promise<void> {
  const popup = page.locator('[role="listbox"]:visible, [role="menu"]:visible, [role="dialog"]:visible').last();
  await popup.waitFor({ state: 'visible', timeout: 5_000 });
  const entry = popup
    .locator('[role="option"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="menuitem"], [role="checkbox"]')
    .nth(n);
  await entry.click();
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'project-tests-search',
    start: '/',
    run: async (page) => {
      await page
        .getByRole('link', { name: /^E2E Checkout/ })
        .first()
        .click();
      await page.waitForURL(/\/projects\/1/);
      await pause(page, 2000);
      await page.getByRole('button', { name: /^Tests/ }).click();
      await pause(page, 1500);
      await page.getByRole('combobox', { name: 'Search tests' }).click();
      await type(page, 'cart');
      await pause(page, 1200);
      await page.getByRole('link', { name: 'should remove item from cart' }).first().click();
      await page.waitForURL(/\/test-cases\//);
      await pause(page, 2000);
    },
  },
  {
    name: 'run-search-filter-sort',
    start: '/test-runs/2',
    run: async (page) => {
      await page.getByRole('combobox', { name: 'Search tests' }).click();
      await type(page, 'checkout');
      await pause(page, 1200);
      // The search's suggestions cover the status buttons until they close.
      await page.keyboard.press('Escape');
      await pause(page, 600);
      await page.getByRole('button', { name: 'Failed', exact: true }).click();
      await pause(page);
      await page.getByRole('combobox', { name: 'Search tests' }).click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await pause(page);
      await page.keyboard.press('Escape');
      await pause(page, 600);
      await page.getByRole('combobox', { name: 'Group tests by' }).click();
      await pickInPopup(page, 0);
      await pause(page);
      await page.getByRole('combobox', { name: 'Sort tests by' }).click();
      await pickInPopup(page, 1);
      await pause(page, 1500);
    },
  },
  {
    name: 'inbox-to-cluster',
    start: '/',
    run: async (page) => {
      await page.getByRole('tab', { name: /^Regressions/ }).click();
      await pause(page, 1200);
      await page.getByRole('link', { name: 'Navigation timeout on / in navigation.spec.ts' }).first().click();
      await page.waitForURL(/\/failure-clusters\//);
      await pause(page, 2500);
    },
  },
  {
    name: 'palette-jump',
    start: '/',
    run: async (page) => {
      await page
        .getByRole('button', { name: /^Search/ })
        .first()
        .click();
      await pause(page, 800);
      await type(page, 'UI Comp');
      await pause(page, 1200);
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/projects\//);
      await pause(page, 2000);
    },
  },
  {
    name: 'project-popovers',
    start: '/projects/1',
    run: async (page) => {
      await page.getByRole('button', { name: 'All branches' }).click();
      await pickInPopup(page, 0);
      await page.keyboard.press('Escape');
      await pause(page);
      await page.getByRole('checkbox', { name: 'Full runs only' }).click();
      await pause(page, 1200);
      await page.getByRole('button', { name: /^Failures/ }).click();
      await pause(page, 1500);
    },
  },
  {
    name: 'run-tag-filter',
    start: '/test-runs/21',
    run: async (page) => {
      // A tag is a qualifier of the search: its suggestions list the run's tags.
      await page.getByRole('combobox', { name: 'Search tests' }).click();
      await type(page, 'tag:');
      await pause(page, 600);
      await pickInPopup(page, 0);
      await page.keyboard.press('Escape');
      await pause(page);
      await page.getByRole('button', { name: 'Passed on retry' }).first().click();
      await pause(page, 1200);
    },
  },
  {
    name: 'execution-tabs',
    start: '/test-run-cases/37',
    run: async (page) => {
      await page.getByRole('tab', { name: 'Source' }).click();
      await pause(page, 1200);
      await page.getByRole('tab', { name: /^Network/ }).click();
      await pause(page, 1200);
      await page.getByRole('button', { name: 'All clues' }).click();
      await pause(page, 1200);
      await page.getByRole('button', { name: 'More actions' }).click();
      await pickInPopup(page, 0);
      await pause(page, 1500);
    },
  },
  {
    name: 'project-edit-form',
    start: '/projects/1?tab=settings',
    run: async (page) => {
      await retype(page, page.getByRole('textbox', { name: 'Description' }), 'Replay lab project');
      await pause(page, 600);
      await page.getByRole('button', { name: 'Source control' }).click();
      await pause(page, 600);
      await retype(page, page.getByRole('textbox', { name: 'Default branch' }), 'main');
      await pause(page, 600);
      await page.getByRole('switch', { name: 'CI re-run' }).click();
      await pause(page, 600);
      await page.getByRole('switch', { name: 'CI re-run' }).click();
      await pause(page, 600);
      await page.getByRole('button', { name: 'Capabilities' }).click();
      await pause(page, 600);
      await page.getByRole('combobox', { name: 'Capture fixtures for this project' }).click();
      await pickInPopup(page, 1);
      await pause(page, 1200);
    },
  },
  {
    name: 'notification-channel-form',
    start: '/settings/notifications',
    run: async (page) => {
      await page.getByRole('button', { name: 'Add channel' }).click();
      await pause(page, 900);
      await page.getByRole('textbox', { name: 'Name' }).click();
      await type(page, 'Lab channel');
      await page.getByRole('textbox', { name: 'Email address' }).click();
      await type(page, 'lab@example.com');
      await pause(page, 600);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await pause(page, 900);
    },
  },
  {
    name: 'tag-dialog',
    start: '/settings/tags',
    run: async (page) => {
      await page.getByRole('button', { name: 'Add tag' }).click();
      await pause(page, 900);
      await page.getByRole('textbox', { name: 'Tag text' }).click();
      await type(page, 'lab-tag');
      await retype(page, page.getByRole('textbox', { name: 'Color', exact: false }).last(), '#22c55e');
      await pause(page, 600);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await pause(page, 900);
    },
  },
  {
    name: 'report-schedule-dialog',
    start: '/reports',
    run: async (page) => {
      await page.getByRole('button', { name: 'New schedule' }).first().click();
      await pause(page, 900);
      await page.getByRole('textbox', { name: 'Name' }).click();
      await type(page, 'Weekly lab');
      await page.getByRole('combobox', { name: 'Report dashboard' }).click();
      await pickInPopup(page, 1);
      await pause(page, 600);
      await page.getByRole('combobox', { name: 'Cadence' }).click();
      await pickInPopup(page, 0);
      await pause(page, 600);
      await retype(page, page.getByRole('textbox', { name: 'At' }), '09:30');
      await page.getByRole('switch', { name: 'AI narrative' }).click();
      await pause(page, 600);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await pause(page, 900);
    },
  },
  {
    name: 'analytics-filters',
    start: '/analytics',
    run: async (page) => {
      await page.getByRole('button', { name: 'Last 30 days' }).click();
      await pause(page, 800);
      await page.getByRole('dialog').getByRole('button', { name: 'Last 90 days' }).click();
      await pause(page, 1500);
      await page.getByRole('combobox', { name: 'Branch policy' }).click();
      await pickInPopup(page, 1);
      await pause(page, 1200);
      await page.getByRole('checkbox', { name: 'Full runs only' }).click();
      await pause(page, 1500);
    },
  },
  {
    name: 'palette-shortcut',
    start: '/',
    run: async (page) => {
      await page.keyboard.press('ControlOrMeta+K');
      await pause(page, 800);
      await type(page, 'Web Dash');
      await pause(page, 1200);
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/projects\//);
      await pause(page, 2000);
    },
  },
  {
    name: 'tag-search-keyboard',
    start: '/test-runs/21',
    run: async (page) => {
      await page.getByRole('combobox', { name: 'Search tests' }).click();
      await pause(page, 600);
      await type(page, 'tag:reg');
      await pause(page, 600);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await pause(page, 600);
      await page.keyboard.press('Escape');
      await pause(page, 1200);
    },
  },
  {
    name: 'test-case-history',
    start: '/test-cases/1',
    run: async (page) => {
      await page.getByRole('button', { name: 'Trend', exact: true }).click();
      await pause(page, 1200);
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      await pause(page, 1200);
      await page.getByRole('link', { name: 'Execution in run #4: failed' }).click();
      await page.waitForURL(/\/test-run-cases\//);
      await pause(page, 2500);
      await page.getByRole('tab', { name: 'Source' }).click();
      await pause(page, 1200);
    },
  },
  {
    name: 'add-user-dialog',
    start: '/settings/users',
    secrets: ['not-a-real-password'],
    run: async (page) => {
      await page.getByRole('button', { name: 'Add user' }).click();
      await pause(page, 900);
      await page.getByRole('textbox', { name: 'Username' }).click();
      await type(page, 'lab-user');
      await page.getByRole('textbox', { name: 'Password' }).click();
      await type(page, 'not-a-real-password');
      await page.getByRole('textbox', { name: 'Display name' }).click();
      await type(page, 'Lab User');
      await page.getByRole('combobox', { name: 'Role' }).click();
      await pickInPopup(page, 1);
      await pause(page, 600);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await pause(page, 900);
    },
  },
  {
    name: 'jira-connect-form',
    start: '/settings/integrations',
    secrets: ['not-a-real-token'],
    run: async (page) => {
      await page.getByRole('button', { name: 'Connect Jira' }).click();
      await pause(page, 900);
      await page.getByRole('textbox', { name: 'Jira site' }).click();
      await type(page, 'https://lab.atlassian.net');
      await page.getByRole('radio', { name: 'Scoped token' }).click();
      await pause(page, 600);
      await page.getByRole('textbox', { name: 'Account email' }).click();
      await type(page, 'lab@example.com');
      await page.getByRole('textbox', { name: 'API token' }).click();
      await type(page, 'not-a-real-token');
      await retype(page, page.getByRole('textbox', { name: 'Token expires on' }), '2027-01-31');
      await pause(page, 600);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await pause(page, 900);
    },
  },
  {
    name: 'runs-table-sort-select',
    start: '/projects/1',
    run: async (page) => {
      await page.getByRole('button', { name: 'Status', exact: true }).click();
      await pause(page, 900);
      await page.getByRole('button', { name: 'Started', exact: true }).click();
      await pause(page, 900);
      await page.getByRole('checkbox', { name: 'Select run #2' }).click();
      await page.getByRole('checkbox', { name: 'Select run #3' }).click();
      await pause(page, 600);
      await page.getByRole('checkbox', { name: 'Select run #2' }).click();
      await pause(page, 1200);
    },
  },
  {
    name: 'analytics-custom-range',
    start: '/analytics',
    run: async (page) => {
      await page.getByRole('button', { name: 'Last 30 days' }).click();
      await pause(page, 800);
      const dialog = page.getByRole('dialog');
      await retype(page, dialog.getByRole('textbox', { name: 'From' }), '2026-08-01');
      await retype(page, dialog.getByRole('textbox', { name: 'To' }), '2026-08-31');
      await dialog.getByRole('button', { name: 'Apply', exact: true }).first().click();
      await pause(page, 1500);
    },
  },
  {
    name: 'inbox-row-actions',
    start: '/',
    hovers: 1,
    run: async (page) => {
      // The row's triage actions show only while it is hovered (`opacity-0 group-hover:opacity-100`).
      const row = page.locator('[data-cluster-row]').first();
      await row.hover();
      await pause(page, 600);
      await row.getByRole('button', { name: /^Assign/ }).click();
      await pause(page, 900);
      await page.keyboard.press('Escape');
      await pause(page, 900);
    },
  },
  {
    name: 'gaps-feature-map',
    start: '/projects/1?tab=gaps',
    hovers: 0,
    run: async (page) => {
      // Hovering a feature highlights it in the map (a script's state); the click lands on the feature itself.
      // Playwright never finds the map's SVG group stable, though it stands still: a person's pointer goes there.
      const feature = page.getByRole('button', { name: /^Orders/ }).first();
      await feature.hover({ force: true });
      await pause(page, 800);
      await feature.click({ force: true });
      await pause(page, 1500);
    },
  },
  {
    name: 'cluster-trend-bucket',
    start: '/failure-clusters/10',
    hovers: 0,
    run: async (page) => {
      // A bucket shows its tooltip on hover (inserted by a script) and opens its list on click.
      const bucket = page.locator('rect.cursor-pointer').last();
      await bucket.hover();
      await pause(page, 800);
      await bucket.click();
      await pause(page, 2000);
    },
  },
  {
    name: 'execution-screenshot-zoom',
    start: '/test-run-cases/37',
    hovers: 0,
    run: async (page) => {
      // The enlarge overlay fades in on hover and lets the click through to the image's button.
      const image = page.getByRole('button', { name: /^Enlarge/ }).first();
      await image.hover();
      await pause(page, 800);
      await image.click();
      await pause(page, 1200);
      await page.keyboard.press('Escape');
      await pause(page, 900);
    },
  },
  {
    name: 'import-file',
    start: '/projects/1/import',
    run: async (page) => {
      // A file on disk, as a person's file chooser gives it: the replay asks for it again (see `harness.ts`).
      await page.locator('input[type="file"]').setInputFiles(labFile('report.zip'));
      await pause(page, 1200);
    },
  },
];
