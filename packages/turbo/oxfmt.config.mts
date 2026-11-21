import { defineConfig } from 'oxfmt'
import base from '../../shared/oxfmt.baseConfig.mts'

export default defineConfig({
  ...base,
  ignorePatterns: ['node_modules'],
})
