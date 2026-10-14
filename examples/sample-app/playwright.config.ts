import { defineConfig } from '@playwright/test';
import { wrapConfig } from '@piwitests/reporter';
import { baseConfig, piwiOptions } from './playwright.shared';

/**
 * The recommended setup: `wrapConfig` adds the Piwi reporter and chains its global setup, so the run shows on the
 * dashboard while your own global setup still runs. playwright.manual-reporter.config.ts adds the reporter by hand.
 */
export default wrapConfig(defineConfig(baseConfig, { reporter: [['list']] }), piwiOptions);
