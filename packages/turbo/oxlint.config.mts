import { defineConfig } from 'oxlint'
import base from '../../shared/oxlint.baseConfig.mts'

export default defineConfig({
  ...base,
  plugins: ['typescript', 'unicorn', 'import'],
  ignorePatterns: [...base.ignorePatterns, 'dist/**', 'bench/workload/app/public/**'],
  rules: {
    ...base.rules,
    'unicorn/prefer-node-protocol': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
  },
})
