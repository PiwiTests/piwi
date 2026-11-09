import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { assistantEntityRoute, type AssistantEntityType } from '#shared/assistant';

/**
 * Every page of an entity a proposal changes reads its data again its own way once the proposal is applied
 * (`usePageReload` with reads that keep what the page shows), so a failed read never empties it.
 */

const appDir = join(__dirname, '../../app');
const ENTITY_TYPES: AssistantEntityType[] = ['project', 'run', 'execution', 'cluster', 'test-case'];

describe('the pages a proposal changes', () => {
  test.each(ENTITY_TYPES)('the %s page registers readers that keep what it shows', (type) => {
    const page = join(appDir, 'pages', `${assistantEntityRoute({ type, id: 0 }).replace(/\/0$/, '')}/[id]`);
    const source = readFileSync(page.endsWith('projects/[id]') ? `${page}/index.vue` : `${page}.vue`, 'utf8');
    expect(source).toMatch(/usePageReload\(/);
    expect(source).toMatch(/refetchKeeping\(/);
  });
});
