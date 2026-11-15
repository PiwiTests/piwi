import { test } from '../../src/test';
import { defineIsolationTests } from './reuse-isolation';

// The same pairs with keepStaticCache under Playwright's own reset.
test.use({ reuseContextWithReset: true, keepStaticCache: true });
defineIsolationTests(test);
