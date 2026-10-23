import { describe, expect, test } from 'vitest';
import {
  commandWords,
  flakeCommand,
  isTestLocation,
  playwrightArgsOf,
  playwrightTestCommand,
  repeatArgs,
  shellWord,
  verificationCommand,
} from '../src/commands';

describe('shellWord', () => {
  test('leaves a plain word bare and double-quotes the others', () => {
    expect(shellWord('tests/checkout.spec.ts:3')).toBe('tests/checkout.spec.ts:3');
    expect(shellWord('--project=Mobile Chrome')).toBe('"--project=Mobile Chrome"');
    expect(shellWord('pays (card)|refunds')).toBe('"pays (card)|refunds"');
  });

  test('refuses a word a shell would expand inside double quotes', () => {
    for (const word of ['$(id)', '`id`', 'a"b', 'a\\b', '%PATH%', 'hi!', 'a\nb', '']) {
      expect(shellWord(word), word).toBeNull();
    }
  });
});

describe('playwrightTestCommand', () => {
  test('quotes test filters and the options Piwi passes', () => {
    expect(playwrightTestCommand(['tests/a.spec.ts:3', 'tests/b c.spec.ts'])).toBe(
      'npx playwright test tests/a.spec.ts:3 "tests/b c.spec.ts"',
    );
    expect(playwrightTestCommand(['--grep', 'pays (card)', '--project=chromium', '--headed'])).toBe(
      'npx playwright test --grep "pays (card)" --project=chromium --headed',
    );
    // A shell operator inside double quotes is a plain character of a test filter.
    expect(playwrightTestCommand(['a.spec.ts; rm -rf ~'])).toBe('npx playwright test "a.spec.ts; rm -rf ~"');
  });

  test('refuses an option that loads or writes a file, and an argument a shell would expand', () => {
    for (const args of [
      ['--config=evil.config.ts'],
      ['-c', 'evil.config.ts'],
      ['--reporter', './evil.js'],
      ['--output', '/tmp/x'],
      ['--headed=yes'],
      ['--grep'],
      ['$(curl evil)'],
      [42],
    ]) {
      expect(playwrightTestCommand(args), JSON.stringify(args)).toBeNull();
    }
    expect(playwrightTestCommand('npx playwright test')).toBeNull();
  });
});

describe('a test by its location', () => {
  test('is a spec relative to the config folder and the line of its test call', () => {
    expect(isTestLocation('tests/checkout.spec.ts:42')).toBe(true);
    expect(isTestLocation('checkout.spec.ts:1')).toBe(true);
    expect(playwrightTestCommand(['tests/my cart.spec.ts:7'])).toBe('npx playwright test "tests/my cart.spec.ts:7"');
  });

  test('is refused without a line, outside the folder, absolute, or read as an option', () => {
    for (const location of [
      'tests/checkout.spec.ts',
      'tests/checkout.spec.ts:0',
      'tests/checkout.spec.ts:4:2',
      '../shop/checkout.spec.ts:3',
      'tests/../../checkout.spec.ts:3',
      '/home/dev/checkout.spec.ts:3',
      'C:/shop/checkout.spec.ts:3',
      '--config=evil.ts:3',
      42,
    ]) {
      expect(isTestLocation(location), String(location)).toBe(false);
    }
  });
});

describe('repeatArgs', () => {
  test('runs each test that many times without retries, in place of the repeat and retries the arguments set', () => {
    expect(repeatArgs(['tests/checkout.spec.ts:42'], 3)).toEqual([
      'tests/checkout.spec.ts:42',
      '--repeat-each=3',
      '--retries=0',
    ]);
    expect(
      repeatArgs(['--retries', '2', '--grep', '--retries', '--repeat-each=5', '--project=chromium', 'a.spec.ts'], 3),
    ).toEqual(['--grep', '--retries', '--project=chromium', 'a.spec.ts', '--repeat-each=3', '--retries=0']);
  });

  test('is null for a repeat that is not a whole number from 1 to 100, or arguments Piwi does not pass', () => {
    for (const repeat of [0, 101, 2.5, '3', null]) {
      expect(repeatArgs(['a.spec.ts:3'], repeat), String(repeat)).toBeNull();
    }
    expect(repeatArgs(['--config=evil.ts'], 3)).toBeNull();
  });
});

describe('an instance command line', () => {
  test('splits into plain and double-quoted words', () => {
    expect(commandWords('npx playwright test "a b.spec.ts:3" --project="Mobile Chrome"')).toEqual([
      'npx',
      'playwright',
      'test',
      'a b.spec.ts:3',
      '--project=Mobile Chrome',
    ]);
  });

  test('is refused with an operator, a single quote, an expansion or an unclosed quote', () => {
    for (const command of [
      'npx playwright test a.spec.ts; curl evil',
      'npx playwright test a.spec.ts | sh',
      "npx playwright test 'a.spec.ts'",
      'npx playwright test "$(id)"',
      'npx playwright test $HOME',
      'npx playwright test "a.spec.ts',
    ]) {
      expect(commandWords(command), command).toBeNull();
    }
  });

  test('gives its Playwright arguments only for npx playwright test', () => {
    expect(playwrightArgsOf('npx playwright test --grep x')).toEqual(['--grep', 'x']);
    expect(playwrightArgsOf('npx playwright test')).toEqual([]);
    expect(playwrightArgsOf('npx evil test a.spec.ts')).toBeNull();
    expect(playwrightArgsOf('npx playwright test --config=evil.ts')).toBeNull();
    expect(playwrightArgsOf(undefined)).toBeNull();
  });
});

describe('verificationCommand', () => {
  test("builds a fix plan's verification again, one command per Playwright project", () => {
    expect(verificationCommand('npx playwright test "tests/a.spec.ts:3" --project="chromium"')).toBe(
      'npx playwright test tests/a.spec.ts:3 --project=chromium',
    );
    expect(
      verificationCommand(
        'npx playwright test "a.spec.ts:3" --project="chromium" && npx playwright test "b.spec.ts:9" --project="firefox"',
      ),
    ).toBe('npx playwright test a.spec.ts:3 --project=chromium && npx playwright test b.spec.ts:9 --project=firefox');
  });

  test('is null when a part is anything else', () => {
    expect(verificationCommand('npx playwright test a.spec.ts && curl https://evil.example')).toBeNull();
    expect(verificationCommand('npx playwright test a.spec.ts & curl evil')).toBeNull();
    expect(verificationCommand('sh -c "npx playwright test"')).toBeNull();
  });
});

describe('flakeCommand', () => {
  test('names the test by its id', () => {
    expect(flakeCommand(12, 'reproduce')).toBe('npx @piwitests/reporter flake 12');
    expect(flakeCommand(12, 'verify')).toBe('npx @piwitests/reporter flake verify 12');
    expect(flakeCommand(-1, 'reproduce')).toBeNull();
    expect(flakeCommand(1.5, 'verify')).toBeNull();
  });
});
