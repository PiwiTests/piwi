import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ONBOARDING, stepAction, stepButton, stepText } from '../src/onboarding';

const screenshots = join(__dirname, '..', '..', '..', 'apps', 'docs', 'public', 'screenshots');

describe('the onboarding script', () => {
  test('gives each step a button of the action catalog in both editors', () => {
    for (const step of ONBOARDING.steps) {
      expect(stepAction(step), step.id).toBeDefined();
      expect(stepButton(step, 'vscode'), `${step.id} in VS Code`).not.toBeNull();
      expect(stepButton(step, 'jetbrains'), `${step.id} in JetBrains`).not.toBeNull();
    }
  });

  test('says each step in each editor’s words', () => {
    const run = ONBOARDING.steps.find((s) => s.id === 'breakpoint')!;
    expect(stepText(run, 'vscode')).toContain('debug the test at the cursor');
    expect(stepText(run, 'jetbrains')).toContain('debug the test at the caret');
    expect(stepButton(run, 'jetbrains')!.label).toBe('Debug the test at the caret');
    const mcp = ONBOARDING.steps.find((s) => s.provided)!;
    expect(stepText(mcp, 'vscode', true)).toBe(mcp.provided);
    expect(stepText(mcp, 'jetbrains', true)).toBe(stepText(mcp, 'jetbrains'));
  });

  test('shows only screenshots the docs have, each editor its own', () => {
    for (const step of ONBOARDING.steps) {
      for (const [editor, image] of Object.entries(step.image ?? {})) {
        expect(image.startsWith(`${editor}-`), image).toBe(true);
        expect(existsSync(join(screenshots, image)), image).toBe(true);
      }
    }
  });
});
