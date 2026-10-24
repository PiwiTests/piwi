import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALL_SKILLS,
  findTemplatesDir,
  readTemplatesVersion,
  installSkills,
  listSkills,
  runSkills,
  SETUP_SKILL,
  WORKFLOW_SKILLS,
} from '../src/cli/skills.js';
import { classifyInstalledSkill, readSkillStamp, stampSkill } from '@piwitests/core/skill-stamp';

const TEMPLATES = path.join(import.meta.dirname, '..', 'templates');

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-skills-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('skill templates ship with the package', () => {
  it('has a SKILL.md with front matter for every declared skill', () => {
    const infos = listSkills(TEMPLATES);
    expect(infos.map((i) => i.slug).sort()).toEqual([...ALL_SKILLS].sort());
    for (const info of infos) {
      expect(info.name).toBeTruthy();
      expect(info.description.length).toBeGreaterThan(20);
    }
  });

  it('separates the setup skill from the workflow skills', () => {
    expect(ALL_SKILLS).toContain(SETUP_SKILL);
    expect(WORKFLOW_SKILLS).not.toContain(SETUP_SKILL);
    expect(WORKFLOW_SKILLS.length).toBe(6);
  });
});

describe('findTemplatesDir', () => {
  it('locates templates/ from a directory inside the package', () => {
    expect(findTemplatesDir(path.join(import.meta.dirname, '..', 'src', 'cli'))).toBe(TEMPLATES);
  });
});

describe('installSkills', () => {
  it('writes each requested skill as <dir>/<slug>/SKILL.md', () => {
    const results = installSkills({
      templatesDir: TEMPLATES,
      root,
      skillsDir: '.claude/skills',
      slugs: WORKFLOW_SKILLS,
      force: false,
      dryRun: false,
    });
    expect(results.every((r) => r.status === 'created')).toBe(true);
    for (const slug of WORKFLOW_SKILLS) {
      const file = path.join(root, '.claude', 'skills', slug, 'SKILL.md');
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toContain(`name: ${slug}`);
    }
  });

  it('writes nothing under --dry-run but still reports what it would create', () => {
    const results = installSkills({
      templatesDir: TEMPLATES,
      root,
      skillsDir: '.claude/skills',
      slugs: [SETUP_SKILL],
      force: false,
      dryRun: true,
    });
    expect(results[0].status).toBe('created');
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
  });

  it('is idempotent: an unchanged reinstall reports already, a divergent one is skipped without --force', () => {
    const opts = { templatesDir: TEMPLATES, root, skillsDir: '.claude/skills', slugs: [SETUP_SKILL], force: false, dryRun: false };
    installSkills(opts);
    expect(installSkills(opts)[0].status).toBe('already');

    const file = path.join(root, '.claude', 'skills', SETUP_SKILL, 'SKILL.md');
    fs.writeFileSync(file, 'edited by hand');
    expect(installSkills(opts)[0].status).toBe('skipped');
    expect(fs.readFileSync(file, 'utf-8')).toBe('edited by hand');

    const forced = installSkills({ ...opts, force: true });
    expect(forced[0].status).toBe('updated');
    expect(fs.readFileSync(file, 'utf-8')).toContain(`name: ${SETUP_SKILL}`);
  });

  it('honors a custom skills directory', () => {
    installSkills({
      templatesDir: TEMPLATES,
      root,
      skillsDir: '.cursor/skills',
      slugs: [SETUP_SKILL],
      force: false,
      dryRun: false,
    });
    expect(fs.existsSync(path.join(root, '.cursor', 'skills', SETUP_SKILL, 'SKILL.md'))).toBe(true);
  });
});

describe('runSkills', () => {
  it('rejects an unknown skill name with exit 2', () => {
    expect(runSkills(['add', 'not-a-skill', '--cwd', root], TEMPLATES)).toBe(2);
  });

  it('installs all skills when none are named', () => {
    expect(runSkills(['add', '--cwd', root], TEMPLATES)).toBe(0);
    for (const slug of ALL_SKILLS) {
      expect(fs.existsSync(path.join(root, '.claude', 'skills', slug, 'SKILL.md'))).toBe(true);
    }
  });

  it('lists skills and exits 0', () => {
    expect(runSkills(['list'], TEMPLATES)).toBe(0);
  });
});

describe('skill version stamps', () => {
  const opts = (version?: string) => ({
    templatesDir: TEMPLATES,
    root,
    skillsDir: '.claude/skills',
    slugs: ['investigate-failure'],
    force: false,
    dryRun: false,
    version,
  });
  const file = () => path.join(root, '.claude', 'skills', 'investigate-failure', 'SKILL.md');

  it('stamps the package version and a hash into the front matter', () => {
    installSkills(opts());
    const stamp = readSkillStamp(fs.readFileSync(file(), 'utf-8'));
    expect(stamp.version).toBe(readTemplatesVersion(TEMPLATES));
    expect(stamp.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.readFileSync(file(), 'utf-8')).toMatch(/^---\nname: investigate-failure\n/);
  });

  it('updates an untouched skill from an older release and reports it outdated', () => {
    installSkills(opts('0.1.0'));
    const [result] = installSkills(opts('0.2.0'));
    expect(result.status).toBe('updated');
    expect(result.detail).toBe('outdated (0.1.0) — updated to 0.2.0');
    expect(readSkillStamp(fs.readFileSync(file(), 'utf-8')).version).toBe('0.2.0');
  });

  it('keeps a skill edited since it was installed, and reports it edited', () => {
    installSkills(opts('0.1.0'));
    fs.appendFileSync(file(), '\nAlways run the smoke suite first.\n');
    const [result] = installSkills(opts('0.2.0'));
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('edited since 0.1.0 installed');
    expect(fs.readFileSync(file(), 'utf-8')).toContain('Always run the smoke suite first.');

    const [forced] = installSkills({ ...opts('0.2.0'), force: true });
    expect(forced.status).toBe('updated');
    expect(fs.readFileSync(file(), 'utf-8')).not.toContain('Always run the smoke suite first.');
  });

  it('classifies a skill against the stamped template', () => {
    const template = fs.readFileSync(path.join(TEMPLATES, 'skills', 'investigate-failure', 'SKILL.md'), 'utf-8');
    const current = stampSkill(template, '0.2.0');
    expect(classifyInstalledSkill(current, current)).toBe('current');
    expect(classifyInstalledSkill(stampSkill(template, '0.1.0'), current)).toBe('outdated');
    expect(classifyInstalledSkill(`${stampSkill(template, '0.1.0')}\nmore`, current)).toBe('edited');
    expect(classifyInstalledSkill(template, current)).toBe('unstamped');
  });
});

describe('workflow skills report back to Piwi', () => {
  const read = (slug: string) => fs.readFileSync(path.join(TEMPLATES, 'skills', slug, 'SKILL.md'), 'utf-8');

  it('ends each workflow with its write-back tools', () => {
    expect(read('investigate-failure')).toContain('submit_diagnosis_feedback');
    expect(read('investigate-failure')).toContain('report_fix_attempt');
    expect(read('investigate-failure')).toContain('record_diagnosis');
    expect(read('apply-locator-healing')).toContain('report_fix_attempt');
    expect(read('write-the-missing-test')).toContain('triage_gap');
  });
});
