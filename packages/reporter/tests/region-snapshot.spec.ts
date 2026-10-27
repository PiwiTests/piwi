import { describe, expect, it } from 'vitest';
import { regionSnapshotWithoutSecrets } from '../src/internal/capture/region-snapshot.js';

const SNAPSHOT = [
  '- region "Sign in":',
  '  - textbox "Email": ada@shop.test',
  '  - textbox "Password": hunter2-secret',
  '  - textbox "PIN" [disabled]: "12 34"',
  '  - link "Forgot?":',
  '    - /url: /reset?token=RESET-SECRET-42',
  '  - link "Help":',
  '    - /url: /help?topic=sign-in',
].join('\n');

describe('the ARIA snapshot Assert a region sends', () => {
  it('leaves out the value of a password field and a link URL that holds a credential, and keeps the rest', () => {
    expect(regionSnapshotWithoutSecrets(SNAPSHOT, ['hunter2-secret', '12 34'])).toBe(
      [
        '- region "Sign in":',
        '  - textbox "Email": ada@shop.test',
        '  - textbox "Password"',
        '  - textbox "PIN" [disabled]',
        '  - link "Forgot?":',
        '  - link "Help":',
        '    - /url: /help?topic=sign-in',
      ].join('\n'),
    );
  });

  it('keeps a text box whose value is no password field’s, and a snapshot with no password field', () => {
    expect(regionSnapshotWithoutSecrets('- textbox "Search": hunter2', ['other'])).toBe('- textbox "Search": hunter2');
    expect(regionSnapshotWithoutSecrets('- textbox "Search": hunter2', [''])).toBe('- textbox "Search": hunter2');
  });
});
