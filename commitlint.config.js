export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot's commits are merged as Dependabot writes them, a capitalised "Bump" included.
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')],
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
