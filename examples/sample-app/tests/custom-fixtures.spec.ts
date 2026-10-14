import { test, expect } from './fixtures-composed';

// Dashboard capture composed with a project-specific fixture (see
// fixtures-composed.ts): the custom fixture drives the page, capture still works.
test('composes dashboard capture with custom fixtures', async ({ formPage }) => {
  await formPage.sendMessage('mary@example.com', 'Sent through a custom fixture');
  await expect(formPage.page.locator('#result')).toHaveText('Sent!');
});
