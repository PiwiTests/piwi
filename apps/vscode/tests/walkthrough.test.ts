import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { PLAYWRIGHT_CONFIGS, WALKTHROUGH } from '../src/glue';

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const { contributes } = manifest;
const [walkthrough] = contributes.walkthroughs;
const commands = new Set<string>(contributes.commands.map((c: { command: string }) => c.command));
const views = new Set<string>(
  Object.values(contributes.views).flatMap((v) => (v as Array<{ id: string }>).map((w) => w.id)),
);
const shipped = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf-8').split('\n');
const sources = fs
  .readdirSync(path.join(root, 'src'))
  .map((file) => fs.readFileSync(path.join(root, 'src', file), 'utf-8'))
  .join('\n');

/** The command a step's button runs: a command link alone on its line. */
const button = (description: string) => /^\[[^\]]+\]\(command:([\w.]+)\)$/m.exec(description)?.[1];

describe('the walkthrough', () => {
  test('is the one Piwi: Get started opens, in the workspaces the extension activates in', () => {
    expect(WALKTHROUGH).toBe(`${manifest.publisher}.${manifest.name}#${walkthrough.id}`);
    expect(commands.has('piwi.getStarted')).toBe(true);
    expect(manifest.activationEvents).toContain(`workspaceContains:${PLAYWRIGHT_CONFIGS}`);
  });

  test('has a button on each step that runs a command of the extension or focuses its view', () => {
    expect(walkthrough.steps.length).toBeGreaterThanOrEqual(4);
    expect(walkthrough.steps.length).toBeLessThanOrEqual(6);
    for (const step of walkthrough.steps) {
      const command = button(step.description);
      expect(command, step.id).toBeDefined();
      expect(commands.has(command!) || views.has(command!.replace(/\.focus$/, '')), command).toBe(true);
    }
  });

  test('checks a step off on the extension’s commands, views and context keys', () => {
    for (const step of walkthrough.steps) {
      expect(step.completionEvents.length, step.id).toBeGreaterThan(0);
      for (const event of step.completionEvents as string[]) {
        const [kind, name] = event.split(/:(.*)/);
        if (kind === 'onCommand') expect(commands.has(name), event).toBe(true);
        else if (kind === 'onView') expect(views.has(name), event).toBe(true);
        else if (kind === 'onContext') expect(sources, event).toContain(`'setContext', '${name}'`);
        else throw new Error(`unexpected completion event ${event}`);
      }
    }
  });

  test('ships the Markdown of each step', () => {
    for (const step of walkthrough.steps) {
      const file = step.media.markdown as string;
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
      expect(shipped, file).toContain(`!${path.posix.dirname(file)}/**`);
    }
  });
});
