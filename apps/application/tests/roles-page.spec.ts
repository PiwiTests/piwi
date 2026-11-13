import { test, expect } from './fixtures';

test.describe('Settings → Roles', () => {
  test('shows what each project role can do, read-only', async ({ page }) => {
    await page.goto('/settings/roles');
    await expect(page.getByRole('heading', { name: 'Project roles' })).toBeVisible();

    const table = page.getByRole('table', { name: 'What each project role can do' });
    const issueRow = table.getByRole('row', { name: /File a Jira issue/ });
    await expect(issueRow.getByText('Contributor can file a jira issue')).toBeAttached();
    await expect(issueRow.getByText('Viewer can file a jira issue')).toHaveCount(0);

    const uploadRow = table.getByRole('row', { name: /Upload runs/ });
    await expect(uploadRow.getByText('Uploader can upload runs')).toBeAttached();
    await expect(uploadRow.getByText('Contributor can upload runs')).toHaveCount(0);

    // Nothing on the page edits a role.
    await expect(page.locator('[data-shot="roles-matrix"]').getByRole('combobox')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Administrator' })).toBeVisible();
  });
});
