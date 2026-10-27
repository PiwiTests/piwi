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
        // Its only child gone, the link ends its line as Playwright writes a node without children.
        '  - link "Forgot?"',
        '  - link "Help":',
        '    - /url: /help?topic=sign-in',
      ].join('\n'),
    );
  });

  it('keeps the colon of a link left with other children, and of a line that never lost one', () => {
    const snapshot = [
      '- link "Reset":',
      '  - img "Key"',
      '  - /url: /reset?token=RESET-SECRET-42',
      '- list:',
      '  - listitem: "Total:"',
      '- link "Last":',
      '  - /url: /reset?token=RESET-SECRET-43',
    ].join('\n');
    expect(regionSnapshotWithoutSecrets(snapshot, [])).toBe(
      ['- link "Reset":', '  - img "Key"', '- list:', '  - listitem: "Total:"', '- link "Last"'].join('\n'),
    );
  });

  it('keeps a text box whose value is no password field’s, and a snapshot with no password field', () => {
    expect(regionSnapshotWithoutSecrets('- textbox "Search": hunter2', ['other'])).toBe('- textbox "Search": hunter2');
    expect(regionSnapshotWithoutSecrets('- textbox "Search": hunter2', [''])).toBe('- textbox "Search": hunter2');
  });
});
