// Dependabot's sign-off trailer, optionally followed by the co-author line a squash merge of its pull request adds.
const DEPENDABOT_TRAILERS =
  /\n\nSigned-off-by: dependabot\[bot\] <support@github\.com>(?:\nCo-authored-by: dependabot\[bot\] <[^>\n]+>)?$/;

export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot's commits are merged as Dependabot writes them, a capitalized "Bump" included: a message that ends with
  // Dependabot's trailers is not linted. Line endings are normalized and git's `#` comment lines dropped first.
  ignores: [
    (message) =>
      DEPENDABOT_TRAILERS.test(
        message
          .replace(/\r\n/g, '\n')
          .replace(/^#.*(?:\n|$)/gm, '')
          .trimEnd(),
      ),
  ],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'docs', 'chore', 'ci', 'refactor', 'test', 'build', 'style', 'revert'],
    ],
    'scope-enum': [
      2,
      'always',
      // 'main' is not a codebase area — it's release-please's own release PR
      // scope (its title/commit is always "chore(<target-branch>): release X.Y.Z").
      [
        'app',
        'reporter',
        'db',
        'ui',
        'demo',
        'desktop',
        'extension',
        'ide',
        'ci',
        'docs',
        'deps',
        'auth',
        'ai',
        'notifications',
        'release',
        'main',
      ],
    ],
    'scope-empty': [1, 'never'],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'header-max-length': [2, 'always', 100],
  },
};
