import { test } from '../../src/test';
import { defineIsolationTests } from './reuse-isolation';

// Playwright's context reuse with turbo's reset.
test.use({ reuseContextWithReset: true });
defineIsolationTests(test);
