/**
 * The checks every answer block passes before it is sent: kebab-case ids
 * unique within the answer, each length and count limit, at most one
 * recommended option, and entities only from the conversation's tool results.
 */
import { describe, expect, test } from 'vitest';
import type { AssistantBlock, AssistantEntityRef } from '#shared/assistant';
import {
  ASSISTANT_BLOCK_LIMITS as L,
  blockGuides,
  checkAssistantBlock,
  endsAssistantAnswer,
  isAssistantBlockTool,
  type AssistantBlockTool,
} from '#shared/assistant-blocks';

const KNOWN: AssistantEntityRef[] = [
  { type: 'run', id: 4, label: 'Run #4' },
  { type: 'test-case', id: 9, label: 'should apply discount code' },
  { type: 'execution', id: 37, label: 'should complete checkout' },
  ...Array.from({ length: 25 }, (_, n) => ({ type: 'test-case' as const, id: 100 + n, label: `test ${n}` })),
];

function check(tool: AssistantBlockTool, args: unknown, usedIds: string[] = []) {
  return checkAssistantBlock(tool, args, {
    entity: (type, id) => KNOWN.find((e) => e.type === type && e.id === id),
    usedIds: new Set(usedIds),
  });
}

function block(tool: AssistantBlockTool, args: unknown): AssistantBlock {
  const result = check(tool, args);
  if (!result.ok) throw new Error(`expected a block, got: ${result.error}`);
  return result.block;
}

function refusal(tool: AssistantBlockTool, args: unknown, usedIds: string[] = []): string {
  const result = check(tool, args, usedIds);
  if (result.ok) throw new Error(`expected a refusal, got a ${result.block.kind} block`);
  return result.error;
}

const text = (n: number) => 'x'.repeat(n);
const choices = (n: number, entity = false) =>
  Array.from({ length: n }, (_, i) =>
    entity ? { id: `c-${i}`, entity: { type: 'test-case', id: 100 + i } } : { id: `c-${i}`, label: `Choice ${i}` },
  );
const options = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `o-${i}`, title: `Option ${i}`, summary: 'Does it.' }));
const stops = (n: number) =>
  Array.from({ length: n }, () => ({ anchor: 'run-incident', title: 'The run', body: 'Look here.' }));

describe('ids', () => {
  test('are kebab-case, at most 60 characters', () => {
    expect(refusal('show_code', { id: 'Not_Kebab', language: 'ts', code: 'x' })).toContain('kebab-case');
    expect(refusal('show_code', { id: 'a--b', language: 'ts', code: 'x' })).toContain('kebab-case');
    expect(refusal('show_code', { id: text(L.idChars + 1), language: 'ts', code: 'x' })).toMatch(/^id: /);
    expect(block('show_code', { id: 'cart-fixture-2', language: 'ts', code: 'x' })).toMatchObject({ kind: 'code' });
  });

  test('a block id is unique within the answer, an item id within its block', () => {
    expect(refusal('show_code', { id: 'fix', language: 'ts', code: 'x' }, ['fix'])).toContain('already the id');
    expect(
      refusal('ask', {
        id: 'q',
        prompt: 'Which?',
        choices: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'B' },
        ],
      }),
    ).toContain('two choices have the id "a"');
    expect(refusal('offer_options', { id: 'o', prompt: 'Which?', options: [...options(2), options(1)[0]] })).toContain(
      'two options have the id',
    );
    expect(
      refusal('checklist', {
        id: 'c',
        title: 'Set up',
        steps: [
          { id: 's', text: 'One' },
          { id: 's', text: 'Two' },
        ],
      }),
    ).toContain('two steps have the id "s"');
  });
});

describe('lengths', () => {
  test('titles at most 60 characters', () => {
    expect(refusal('show_code', { id: 'c', language: 'ts', code: 'x', title: text(61) })).toMatch(/^title: /);
    expect(refusal('checklist', { id: 'c', title: text(61), steps: [{ id: 's', text: 'One' }] })).toMatch(/^title: /);
    expect(
      refusal('offer_options', {
        id: 'o',
        prompt: 'Which?',
        options: [{ ...options(1)[0], title: text(61) }, ...options(1).map((o) => ({ ...o, id: 'o-1' }))],
      }),
    ).toContain('options.0.title');
  });

  test('prompts at most 300 characters, labels at most 120', () => {
    expect(refusal('ask', { id: 'q', prompt: text(L.promptChars + 1), choices: choices(2) })).toMatch(/^prompt: /);
    expect(
      refusal('ask', {
        id: 'q',
        prompt: 'Which?',
        choices: [{ id: 'a', label: text(L.labelChars + 1) }, choices(2)[1]],
      }),
    ).toContain('choices.0.label');
    expect(refusal('navigate', { id: 'n', route: '/settings/ai', label: text(121) })).toMatch(/^label: /);
    expect(
      refusal('offer_options', {
        id: 'o',
        prompt: 'Which?',
        options: [{ ...options(2)[0], summary: text(121) }, options(2)[1]],
      }),
    ).toContain('options.0.summary');
  });

  test('a command at most 2,000 characters in each shell, code and a patch at most 8,000', () => {
    expect(refusal('show_command', { id: 'c', bash: text(L.commandChars + 1) })).toMatch(/^bash: /);
    expect(refusal('show_command', { id: 'c', bash: 'npm test', powershell: text(2001) })).toMatch(/^powershell: /);
    expect(block('show_command', { id: 'c', bash: text(2000), powershell: text(1999) })).toMatchObject({
      kind: 'command',
    });
    expect(refusal('show_code', { id: 'c', language: 'ts', code: text(L.codeChars + 1) })).toMatch(/^code: /);
    expect(refusal('show_patch', { id: 'p', patch: text(L.codeChars + 1), target: { type: 'run', id: 4 } })).toMatch(
      /^patch: /,
    );
  });

  test("a guide's title at most 60 characters, a stop's body at most 360", () => {
    expect(refusal('show_guide', { id: 'g', title: text(61), stops: stops(1) })).toMatch(/^title: /);
    expect(
      refusal('show_guide', { id: 'g', title: 'Where', stops: [{ ...stops(1)[0], body: text(L.guideBodyChars + 1) }] }),
    ).toContain('stops.0.body');
    expect(refusal('show_guide', { id: 'g', title: 'Where', stops: [{ ...stops(1)[0], title: text(61) }] })).toContain(
      'stops.0.title',
    );
  });
});

describe('counts', () => {
  test('two to four options, at most one recommended', () => {
    expect(refusal('offer_options', { id: 'o', prompt: 'Which?', options: options(1) })).toMatch(/^options: /);
    expect(refusal('offer_options', { id: 'o', prompt: 'Which?', options: options(5) })).toMatch(/^options: /);
    const recommended = options(3).map((o, i) => ({ ...o, recommended: i < 2 }));
    expect(refusal('offer_options', { id: 'o', prompt: 'Which?', options: recommended })).toBe(
      'options: at most one option is recommended',
    );
    const one = options(4).map((o, i) => ({ ...o, recommended: i === 1 }));
    const built = block('offer_options', { id: 'o', prompt: 'Which?', options: one });
    expect(built.kind === 'options' && built.options.filter((o) => o.recommended)).toHaveLength(1);
  });

  test('at most 10 choices, or 20 when every choice is an entity', () => {
    expect(block('ask', { id: 'q', prompt: 'Which?', choices: choices(10) })).toMatchObject({ kind: 'question' });
    expect(refusal('ask', { id: 'q', prompt: 'Which?', choices: choices(11) })).toContain('at most 10 choices');
    expect(block('ask', { id: 'q', prompt: 'Which?', choices: choices(20, true) })).toMatchObject({ kind: 'question' });
    expect(refusal('ask', { id: 'q', prompt: 'Which?', choices: choices(21, true) })).toMatch(/^choices: /);
    const mixed = [...choices(10, true), { id: 'other-one', label: 'None of these' }];
    expect(refusal('ask', { id: 'q', prompt: 'Which?', choices: mixed })).toContain('at most 10 choices');
    expect(refusal('ask', { id: 'q', prompt: 'Which?', choices: choices(1) })).toMatch(/^choices: /);
  });

  test('radio buttons start with at most one choice checked', () => {
    const checked = choices(3).map((c) => ({ ...c, checked: true }));
    expect(refusal('ask', { id: 'q', prompt: 'Which?', choices: checked })).toContain('at most one checked');
    expect(block('ask', { id: 'q', prompt: 'Which?', multiple: true, choices: checked })).toMatchObject({
      multiple: true,
    });
  });

  test('at most 12 checklist steps, at most 7 guide stops', () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s-${i}`, text: `Step ${i}` }));
    expect(block('checklist', { id: 'c', title: 'Set up', steps: steps(12) })).toMatchObject({ kind: 'checklist' });
    expect(refusal('checklist', { id: 'c', title: 'Set up', steps: steps(13) })).toMatch(/^steps: /);
    expect(block('show_guide', { id: 'g', title: 'Where', stops: stops(7) })).toMatchObject({ kind: 'guide' });
    expect(refusal('show_guide', { id: 'g', title: 'Where', stops: stops(8) })).toMatch(/^stops: /);
  });
});

describe('entities', () => {
  test('a card is only an entity a tool result named, with the label the result gave', () => {
    expect(block('show_entity', { id: 'e', entity: { type: 'test-case', id: 9 }, detail: 'The flakiest.' })).toEqual({
      kind: 'entity',
      id: 'e',
      entity: { type: 'test-case', id: 9, label: 'should apply discount code' },
      detail: 'The flakiest.',
    });
    expect(refusal('show_entity', { id: 'e', entity: { type: 'run', id: 5 } })).toBe(
      'entity: no tool result of this conversation named run 5; read it with a tool first, or leave it out',
    );
  });

  test("a choice's entity must be one a tool result named, and names the choice when it has no label", () => {
    const asked = block('ask', {
      id: 'q',
      prompt: 'Which test?',
      choices: [
        { id: 'flaky', entity: { type: 'test-case', id: 9 } },
        { id: 'other-run', label: 'The latest run', entity: { type: 'run', id: 4 } },
      ],
    });
    expect(asked.kind === 'question' && asked.choices.map((c) => c.label)).toEqual([
      'should apply discount code',
      'The latest run',
    ]);
    expect(
      refusal('ask', {
        id: 'q',
        prompt: 'Which test?',
        choices: [
          { id: 'a', entity: { type: 'test-case', id: 9 } },
          { id: 'b', entity: { type: 'test-case', id: 999 } },
        ],
      }),
    ).toContain('choices.1.entity: no tool result of this conversation named test-case 999');
    expect(refusal('ask', { id: 'q', prompt: 'Which?', choices: [{ id: 'a' }, { id: 'b', label: 'B' }] })).toContain(
      'needs a label',
    );
  });

  test("a patch's target must be one a tool result named; its validation is the server's to fill", () => {
    const patch = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
    expect(refusal('show_patch', { id: 'p', patch, target: { type: 'cluster', id: 3 } })).toContain('named cluster 3');
    expect(block('show_patch', { id: 'p', patch, target: { type: 'execution', id: 37 } })).toMatchObject({
      kind: 'patch',
      validation: null,
    });
  });
});

describe('blocks', () => {
  test('a command keeps its PowerShell form only when it differs from the bash one', () => {
    expect(block('show_command', { id: 'c', bash: 'npx playwright test', powershell: 'npx playwright test' })).toEqual({
      kind: 'command',
      id: 'c',
      command: { bash: 'npx playwright test' },
    });
    expect(
      block('show_command', { id: 'c', bash: 'PIWI_URL=x npx piwi', powershell: "$env:PIWI_URL='x'; npx piwi" }),
    ).toMatchObject({ command: { bash: 'PIWI_URL=x npx piwi', powershell: "$env:PIWI_URL='x'; npx piwi" } });
  });

  test('a question and an options block end the answer; the others do not', () => {
    expect(endsAssistantAnswer(block('ask', { id: 'q', prompt: 'Which?', choices: choices(2) }))).toBe(true);
    expect(endsAssistantAnswer(block('offer_options', { id: 'o', prompt: 'Which?', options: options(2) }))).toBe(true);
    expect(endsAssistantAnswer(block('show_code', { id: 'c', language: 'ts', code: 'x' }))).toBe(false);
  });

  test('lists the guides a block carries, with their place in the arguments', () => {
    const guide = { title: 'Where', stops: stops(1) };
    expect(blockGuides(block('show_guide', { id: 'g', ...guide })).map((g) => g.where)).toEqual(['']);
    const withGuides = block('checklist', {
      id: 'c',
      title: 'Set up',
      steps: [
        { id: 'a', text: 'One' },
        { id: 'b', text: 'Two', guide },
      ],
    });
    expect(blockGuides(withGuides).map((g) => g.where)).toEqual(['steps.1.guide']);
    expect(
      blockGuides(
        block('offer_options', { id: 'o', prompt: 'Which?', options: [{ ...options(2)[0], guide }, options(2)[1]] }),
      ).map((g) => g.where),
    ).toEqual(['options.0.guide']);
  });

  test('names the block tools', () => {
    expect(isAssistantBlockTool('ask')).toBe(true);
    expect(isAssistantBlockTool('get_run')).toBe(false);
    expect(isAssistantBlockTool('toString')).toBe(false);
  });
});
