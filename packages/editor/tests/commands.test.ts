import { describe, expect, test } from 'vitest';
import { requiredTagsGrepInvert } from '@piwitests/core/environments';
import {
  commandWords,
  isRequiredTagsFilter,
  playwrightNodeCommand,
  flakeCommand,
  isTestLocation,
  locationSpec,
  playwrightArgsOf,
  playwrightTestCommand,
  repeatArgs,
  runName,
  commandName,
  shellWord,
  verificationCommand,
  withRequiredTags,
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

  test('refuses the typographic double quotes PowerShell reads as a quote', () => {
    for (const quote of ['\u201C', '\u201D', '\u201E']) {
      expect(shellWord(`--project=chromium${quote} ; calc.exe ; #`), quote).toBeNull();
    }
    expect(shellWord('--project=Chrome ‘mobile’')).toBe('"--project=Chrome ‘mobile’"');
  });
});

describe('a protected environment’s required tags', () => {
  test('keep a run to the tests carrying one of them, merged with the run’s own --grep-invert, last', () => {
    const only = requiredTagsGrepInvert(['@smoke', '@readonly']);
    expect(withRequiredTags(['tests/a.spec.ts:3', '--headed'], ['@smoke', '@readonly'])).toEqual([
      'tests/a.spec.ts:3',
      '--headed',
      '--grep-invert',
      only,
    ]);
    const merged = requiredTagsGrepInvert(['@smoke'], 'slow');
    expect(withRequiredTags(['--grep-invert', 'slow', 'tests/a.spec.ts'], ['@smoke'])).toEqual([
      'tests/a.spec.ts',
      '--grep-invert',
      merged,
    ]);
    expect(withRequiredTags(['--grep-invert=slow', '--repeat-each=3'], ['@smoke'])).toEqual([
      '--repeat-each=3',
      '--grep-invert',
      merged,
    ]);
    expect(withRequiredTags(['--config', 'other.config.ts'], ['@smoke'])).toBeNull();
  });

  test('read -G as --grep-invert, the last of them the run’s own, and a --shuffle seed as Playwright does', () => {
    const merged = requiredTagsGrepInvert(['@smoke'], 'slow');
    expect(withRequiredTags(['-G', 'slow', 'tests/a.spec.ts'], ['@smoke'])).toEqual([
      'tests/a.spec.ts',
      '--grep-invert',
      merged,
    ]);
    expect(withRequiredTags(['--grep-invert', 'wip', '-G', 'slow'], ['@smoke'])).toEqual(['--grep-invert', merged]);
    expect(withRequiredTags(['-G', 'wip', '--grep-invert=slow'], ['@smoke'])).toEqual(['--grep-invert', merged]);
    // A --shuffle written without a seed takes no option as its seed.
    expect(withRequiredTags(['--shuffle', '-G', 'slow'], ['@smoke'])).toEqual(['--shuffle', '--grep-invert', merged]);
    expect(withRequiredTags(['--shuffle', '42', '-G', 'slow'], ['@smoke'])).toEqual([
      '--shuffle',
      '42',
      '--grep-invert',
      merged,
    ]);
  });

  test('write a filter every shell reads as it is in double quotes, and nothing else past the usual checks', () => {
    const filter = requiredTagsGrepInvert(['@smoke'], 'slow|wip');
    expect(isRequiredTagsFilter(filter)).toBe(true);
    expect(playwrightTestCommand(['tests/a.spec.ts', '--grep-invert', filter])).toBe(
      `npx playwright test tests/a.spec.ts --grep-invert "${filter}"`,
    );
    // A run's own pattern a shell would expand, or a filter changed by a character, stays refused.
    for (const word of [
      requiredTagsGrepInvert(['@smoke'], '$(id)'),
      requiredTagsGrepInvert(['@smoke'], 'a"b'),
      `${requiredTagsGrepInvert(['@smoke'])}$(id)`,
      requiredTagsGrepInvert(['@smoke']).replace('(?!', '(?!$(id)'),
    ]) {
      expect(isRequiredTagsFilter(word), word).toBe(false);
      expect(shellWord(word), word).toBeNull();
    }
  });
});

describe('playwrightNodeCommand', () => {
  test('starts the project’s Playwright CLI with node, its path written with /', () => {
    const filter = requiredTagsGrepInvert(['@smoke']);
    expect(
      playwrightNodeCommand('C:\\Users\\Dana Lee\\shop\\node_modules\\@playwright\\test\\cli.js', [
        'tests/a.spec.ts:3',
        '--grep-invert',
        filter,
      ]),
    ).toBe(
      `node "C:/Users/Dana Lee/shop/node_modules/@playwright/test/cli.js" test tests/a.spec.ts:3 --grep-invert "${filter}"`,
    );
  });

  test('writes nothing without the CLI, or for arguments it would not run', () => {
    expect(playwrightNodeCommand(null, ['tests/a.spec.ts'])).toBeNull();
    expect(playwrightNodeCommand('/w/cli.js', ['--config', 'x.ts'])).toBeNull();
    expect(playwrightNodeCommand('/w/$(id)/cli.js', ['tests/a.spec.ts'])).toBeNull();
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

  test('takes -G, the short form of --grep-invert, and --shuffle with or without a seed', () => {
    expect(playwrightTestCommand(['-G', 'slow (wip)', 'a.spec.ts'])).toBe(
      'npx playwright test -G "slow (wip)" a.spec.ts',
    );
    expect(playwrightTestCommand(['--shuffle', 'a.spec.ts'])).toBe('npx playwright test --shuffle a.spec.ts');
    expect(playwrightTestCommand(['a.spec.ts', '--shuffle'])).toBe('npx playwright test a.spec.ts --shuffle');
    expect(playwrightTestCommand(['--shuffle=1234', '--headed'])).toBe('npx playwright test --shuffle=1234 --headed');
    expect(playwrightArgsOf('npx playwright test --shuffle -G slow')).toEqual(['--shuffle', '-G', 'slow']);
    for (const args of [['-G'], ['--shuffle=$(id)'], ['--shuffle', '-5'], ['-Gslow']]) {
      expect(playwrightTestCommand(args), JSON.stringify(args)).toBeNull();
    }
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
    // Without a line, every test of the spec.
    expect(isTestLocation('tests/checkout.spec.ts')).toBe(true);
    expect(locationSpec('tests/checkout.spec.ts:42')).toBe('tests/checkout.spec.ts');
    expect(locationSpec('tests/checkout.spec.ts')).toBe('tests/checkout.spec.ts');
    expect(playwrightTestCommand(['tests/my cart.spec.ts:7'])).toBe('npx playwright test "tests/my cart.spec.ts:7"');
  });

  test('is refused outside the folder, absolute, or read as an option', () => {
    for (const location of [
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
    // A --shuffle written without a seed takes no option as its seed.
    expect(repeatArgs(['--shuffle', '--retries', '2', 'a.spec.ts'], 3)).toEqual([
      '--shuffle',
      'a.spec.ts',
      '--repeat-each=3',
      '--retries=0',
    ]);
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

describe('runName', () => {
  test('names a run by its first test file and how many more, else the title it greps, else every test', () => {
    expect(runName(['tests/checkout.spec.ts:12'])).toBe('checkout.spec.ts:12');
    // A dashboard's copied filter, each character its `file:` URL may encode written both ways.
    expect(runName(['/tests/(?:[[]|.5B)id(?:]|.5D).spec.ts:3'])).toBe('[id].spec.ts:3');
    expect(runName(['/tests/caf(?:é|.C3.A9)(?: |.20)a.spec.ts'])).toBe('café a.spec.ts');
    expect(runName(['/my(?: |.20)tests/(?:😀|.F0.9F.98.80).spec.ts'])).toBe('😀.spec.ts');
    expect(runName(['tests/a.spec.ts', 'tests/b.spec.ts', 'tests/c.spec.ts', '--headed'])).toBe('a.spec.ts and 2 more');
    expect(runName(['-g', 'pays by card', '--workers=1'])).toBe('pays by card');
    expect(runName(['--project=chromium'])).toBe('every test');
  });

  test('reads the arguments as the service builds them', () => {
    expect(runName(['tests/my flows/a.spec.ts:3'])).toBe('a.spec.ts:3');
    expect(runName(['app/[[]id]/page.spec.ts:3', 'c[+][+].spec.ts'])).toBe('page.spec.ts:3 and 1 more');
    expect(runName(['tests/[[]id].spec.ts'])).toBe('[id].spec.ts');
    expect(runName(['--grep=pays by card', '--project', 'chromium'])).toBe('pays by card');
    expect(runName(['--project', 'setup.spec.ts', '--grep=pays'])).toBe('pays');
    expect(runName(['tests/checkout.spec.ts:12', '--repeat-each', '3'])).toBe('checkout.spec.ts:12 ×3');
    expect(runName(['tests/checkout.spec.ts:12', '--repeat-each=1'])).toBe('checkout.spec.ts:12');
    expect(runName(['checkout', 'tests/e2e/'])).toBe('checkout and 1 more');
    expect(runName(['/w/tests/e2e/.'])).toBe('e2e');
    expect(runName(['^/w/tests/e2e/.', '^/w/tests/a.spec.ts:3'])).toBe('e2e and 1 more');
    expect(runName(['^(?:C:/w/my cart.spec.ts|file:///C:/w/my.20cart.spec.ts):3'])).toBe('my cart.spec.ts:3');
    expect(runName(['(?:/w/my tests [(]1[)]|/w/my.20tests.20[(]1[)])/.'])).toBe('my tests (1)');
    expect(runName(['(?:tests/my cart.spec.ts|tests/my.20cart.spec.ts):3'])).toBe('my cart.spec.ts:3');
    expect(runName(['(?:/w/a[|]b c|/w/a[|]b.20c)/.'])).toBe('a|b c');
    expect(runName(['--grep=(?:^| )(?:pays|refunds)$'])).toBe('tests by title');
    // A --shuffle seed, written after it or with `=`, is no filter; an option after it is no seed.
    expect(runName(['--shuffle', '--grep', 'pays'])).toBe('pays');
    expect(runName(['--shuffle=7', 'tests/a.spec.ts:3'])).toBe('a.spec.ts:3');
    expect(runName(['--shuffle', '7', '-G', 'slow'])).toBe('every test');
  });

  test('names a command by its words, a chain of playwright test whole, any other up to its first option', () => {
    expect(commandName('npx @piwitests/reporter flake 42')).toBe('piwi flake 42');
    expect(commandName('npx @piwitests/reporter flake verify 3 --server-url http://x && echo')).toBe(
      'piwi flake verify 3',
    );
    expect(commandName('npx playwright test a.spec.ts --repeat-each=10 && npx playwright test b.spec.ts')).toBe(
      'playwright test a.spec.ts --repeat-each=10 && playwright test b.spec.ts',
    );
  });
});
