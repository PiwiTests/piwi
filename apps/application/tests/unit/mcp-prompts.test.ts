import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSetupPiwiMessages,
  buildSkillPromptMessages,
  isKnownPrompt,
  splitSkill,
} from '../../server/utils/mcp/prompts';
import { MCP_PROMPT_DEFS, SKILL_PROMPTS } from '#shared/mcp-prompts';

describe('isKnownPrompt', () => {
  it('recognizes every declared prompt and rejects others', () => {
    for (const def of MCP_PROMPT_DEFS) expect(isKnownPrompt(def.name)).toBe(true);
    expect(isKnownPrompt('setup_piwi')).toBe(true);
    expect(isKnownPrompt('nonexistent')).toBe(false);
  });
});

describe('buildSetupPiwiMessages', () => {
  const base = { baseUrl: 'https://piwi.example.com', authEnabled: false, existingProjects: [] as string[] };

  it('returns a single user message and a description naming the dashboard', () => {
    const result = buildSetupPiwiMessages(base);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content.type).toBe('text');
    expect(result.description).toContain('https://piwi.example.com');
  });

  it('bakes the dashboard URL into the init command', () => {
    const text = buildSetupPiwiMessages(base).messages[0]!.content.text;
    expect(text).toContain(
      'npx @piwitests/reporter init --server-url https://piwi.example.com --project <project-name>',
    );
    expect(text).toContain('Authentication: not required');
  });

  it('uses a supplied project name in place of the placeholder', () => {
    const text = buildSetupPiwiMessages({ ...base, projectName: 'checkout' }).messages[0]!.content.text;
    expect(text).toContain('--project checkout');
    expect(text).not.toContain('<project-name>');
    expect(text).toContain('project "checkout"');
  });

  it('spells out the API-key steps when authentication is required', () => {
    const text = buildSetupPiwiMessages({ ...base, authEnabled: true }).messages[0]!.content.text;
    expect(text).toContain('Authentication: required');
    expect(text).toContain('requires authentication');
    expect(text).toContain('PIWI_API_KEY');
    expect(text).toContain('pd_');
    expect(text).toContain('the Uploader, Maintainer or Project admin role');
  });

  it('lists existing projects so the agent can reuse a name', () => {
    const text = buildSetupPiwiMessages({ ...base, existingProjects: ['checkout', 'marketing'] }).messages[0]!.content
      .text;
    expect(text).toContain('Projects that already exist: checkout, marketing');
    expect(text).toContain('reuse that exact name');
  });

  it('says so when the dashboard has no projects yet', () => {
    const text = buildSetupPiwiMessages(base).messages[0]!.content.text;
    expect(text).toContain('Projects that already exist: none yet');
    expect(text).toContain('first project');
  });

  it('truncates a very long project list and reports the total', () => {
    const many = Array.from({ length: 25 }, (_, i) => `proj-${i}`);
    const text = buildSetupPiwiMessages({ ...base, existingProjects: many }).messages[0]!.content.text;
    expect(text).toContain('(25 total)');
  });

  it('always closes with the verification step', () => {
    const text = buildSetupPiwiMessages(base).messages[0]!.content.text;
    expect(text).toContain('npx playwright test');
    expect(text).toContain('PIWI_OUTPUT_FILE=piwi-run.json');
  });
});

describe('workflow skills served as prompts', () => {
  const skillsDir = fileURLToPath(new URL('../../../../packages/reporter/templates/skills', import.meta.url));
  const skillPrompts = MCP_PROMPT_DEFS.filter((def) => 'skill' in def);

  it('serves the six workflow skills, each named after its skill', () => {
    expect(skillPrompts.map((def) => def.name)).toEqual([
      'investigate_failure',
      'apply_locator_healing',
      'stabilize_flaky_tests',
      'run_the_right_tests',
      'write_the_missing_test',
      'fix_a_reported_bug',
    ]);
    for (const def of skillPrompts) {
      expect(SKILL_PROMPTS.get(def.name)).toBe(def.name.replace(/_/g, '-'));
      expect(def.arguments.map((a) => a.name)).toEqual(['focus']);
    }
  });

  it("describes each prompt with its skill's own description", () => {
    for (const def of skillPrompts) {
      const markdown = readFileSync(join(skillsDir, SKILL_PROMPTS.get(def.name)!, 'SKILL.md'), 'utf-8');
      expect(splitSkill(markdown).description, def.name).toBe(def.description);
    }
  });

  it('builds the prompt from the skill body, with the version and the focus', () => {
    const markdown = readFileSync(join(skillsDir, 'investigate-failure', 'SKILL.md'), 'utf-8');
    const result = buildSkillPromptMessages({
      skill: 'investigate-failure',
      markdown,
      version: '0.46.0',
      focus: 'cluster 214',
    });
    const text = result.messages[0]!.content.text;
    expect(
      text.startsWith('Follow the Piwi workflow below (the `investigate-failure` skill, as shipped with Piwi 0.46.0)'),
    ).toBe(true);
    expect(text).toContain('Work on: cluster 214');
    expect(text).toContain('# Investigate a Piwi failure');
    expect(text).toContain('report_fix_attempt');
    expect(text).not.toContain('description:');
    expect(result.description).toBe(splitSkill(markdown).description);
  });
});
