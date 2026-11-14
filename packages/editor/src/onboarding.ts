/**
 * The onboarding script: the first steps with Piwi, written once for both editors. VS Code plays them as its
 * walkthrough (`contributes.walkthroughs`, held to this file by `apps/vscode/tests/walkthrough.test.ts`); the JetBrains
 * plugin as its Get Started tab, from `OnboardingSteps`, which `GlueTest` holds to this file. Each step names its button
 * by the action catalog's title, says `{cursor}` and `{window}` in each editor's word, and shows a docs screenshot
 * (`apps/docs/public/screenshots`) in the editors that have one.
 */
import script from './onboarding.json' with { type: 'json' };
import { EDITOR_ACTIONS, EDITOR_WORDS, actionTitle, type Editor, type EditorAction } from './actions.js';

export interface OnboardingStep {
  id: string;
  title: string;
  /** What the step says, the same in both editors or in each one's words. */
  text: string | Readonly<Record<Editor, string>>;
  /** VS Code's words where the editor lists Piwi's MCP server for its agent itself (VS Code 1.101 and later). */
  provided?: string;
  /** The title of the action catalog's entry the step's button runs. */
  action: string;
  /** The command VS Code's button runs where the catalog has none for it, such as a view's focus. */
  vscodeCommand?: string;
  /** The docs screenshot each editor shows beside the step, by file name. */
  image?: Partial<Record<Editor, string>>;
}

export const ONBOARDING: { title: string; description: string; steps: readonly OnboardingStep[] } = script;

/** `text` with `{cursor}` and `{window}` in `editor`'s words. */
function inWords(text: string, editor: Editor): string {
  return text.replace(/\{(cursor|window)\}/g, (_, word: 'cursor' | 'window') => EDITOR_WORDS[editor][word]);
}

/** What a step says in `editor`; with `provided`, VS Code's words where it lists Piwi's MCP server itself. */
export function stepText(step: OnboardingStep, editor: Editor, provided = false): string {
  const text = provided && editor === 'vscode' && step.provided ? step.provided : step.text;
  return inWords(typeof text === 'string' ? text : text[editor], editor);
}

/** The catalog entry a step's button runs. */
export function stepAction(step: OnboardingStep): EditorAction | undefined {
  return EDITOR_ACTIONS.find((a) => a.title === step.action);
}

/** A step's button in `editor`: its label and the command or action it runs, or null when the editor has none. */
export function stepButton(step: OnboardingStep, editor: Editor): { label: string; run: string } | null {
  const action = stepAction(step);
  if (!action) return null;
  const run = editor === 'vscode' ? (step.vscodeCommand ?? action.vscode) : action.jetbrains?.[0];
  return run ? { label: actionTitle(action, editor), run } : null;
}
