import { describe, test, expect } from 'vitest';
import config from '../../../../commitlint.config.js';

const ignored = (message: string) => config.ignores.some((ignore: (message: string) => boolean) => ignore(message));

const DEPENDABOT = [
  'Bump the actions group with 2 updates',
  '',
  'Bumps the actions group with 2 updates.',
  '',
  '---',
  'updated-dependencies:',
  '- dependency-name: actions/checkout',
  '  dependency-type: direct:production',
  '  dependency-group: actions',
  '...',
  '',
  'Signed-off-by: dependabot[bot] <support@github.com>',
].join('\n');

describe('commitlint.config.js ignores', () => {
  test("skips a message that ends with Dependabot's sign-off trailer", () => {
    expect(ignored(DEPENDABOT)).toBe(true);
    expect(ignored(`${DEPENDABOT}\n`)).toBe(true);
  });

  test('lints a message that mentions the trailer outside its last line', () => {
    expect(ignored('Whatever Bad header.\n\nquoting Signed-off-by: dependabot[bot] in the body\n')).toBe(false);
    expect(ignored('Signed-off-by: dependabot[bot] <support@github.com>')).toBe(false);
    expect(ignored(`${DEPENDABOT}\nSigned-off-by: someone <someone@example.com>`)).toBe(false);
    expect(ignored('Bad header\n\nSigned-off-by: dependabot[bot] <support@github.com> and more')).toBe(false);
  });

  test('lints an ordinary message', () => {
    expect(ignored('fix(ci): lint every commit\n\nSigned-off-by: someone <someone@example.com>\n')).toBe(false);
  });
});
