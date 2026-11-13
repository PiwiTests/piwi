/**
 * `piwi skills` — install the Piwi agent skills into a project, and the shared
 * logic `init` reuses to do the same.
 *
 * A skill is a single `SKILL.md` file (the portable open format: a YAML
 * front-matter block naming the skill, then Markdown instructions). Any agent
 * that reads skills from a directory — Claude Code out of `.claude/skills/`,
 * others from wherever they look — can pick them up. The files are agent-
 * agnostic Markdown; only the destination directory is tool-specific, so
 * `--dir` points the install wherever a given agent reads from.
 *
 * An installed skill carries two stamps in its front matter
 * (`@piwitests/core/skill-stamp`): the package version it came from and a hash
 * of the file as written. A later `add` replaces an untouched skill from an
 * older release (outdated) and keeps one a person changed (edited) unless
 * `--force`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyInstalledSkill, readSkillStamp, stampSkill } from '@piwitests/core/skill-stamp';
import type { StepResult } from './report.js';

/** The setup skill drives this very command; the rest act on a run's results. */
export const SETUP_SKILL = 'setup-piwi';
export const WORKFLOW_SKILLS = [
  'investigate-failure',
  'apply-locator-healing',
  'stabilize-flaky-tests',
  'run-the-right-tests',
  'write-the-missing-test',
  'fix-a-reported-bug',
] as const;
export const ALL_SKILLS = [SETUP_SKILL, ...WORKFLOW_SKILLS] as const;

/** Default destination — the directory Claude Code reads project skills from. */
export const DEFAULT_SKILLS_DIR = path.join('.claude', 'skills');

export interface SkillInfo {
  slug: string;
  name: string;
  description: string;
}

/**
 * Locate the package's bundled `templates/` directory by walking up from a
 * starting directory until `templates/skills/` is found. Works from the
 * published layout (`dist/cli/`) and from the source tree (`src/cli/`) alike.
 */
export function findTemplatesDir(fromDir: string): string {
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'templates', 'skills'))) return path.join(dir, 'templates');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(fromDir, '..', '..', 'templates');
}

/** Read `name` and `description` out of a SKILL.md's YAML front matter. */
function readFrontMatter(markdown: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1] as 'name' | 'description'] = kv[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/** The version of the package the templates ship in, read from its `package.json`. */
export function readTemplatesVersion(templatesDir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(templatesDir, '..', 'package.json'), 'utf-8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function templatePath(templatesDir: string, slug: string): string {
  return path.join(templatesDir, 'skills', slug, 'SKILL.md');
}

/** Metadata for the given skills (defaults to all), skipping any missing template. */
export function listSkills(templatesDir: string, slugs: ReadonlyArray<string> = ALL_SKILLS): SkillInfo[] {
  const infos: SkillInfo[] = [];
  for (const slug of slugs) {
    const file = templatePath(templatesDir, slug);
    if (!fs.existsSync(file)) continue;
    const front = readFrontMatter(fs.readFileSync(file, 'utf-8'));
    infos.push({ slug, name: front.name ?? slug, description: front.description ?? '' });
  }
  return infos;
}

export interface InstallSkillsOptions {
  templatesDir: string;
  /** Absolute project root the skill directory is created under. */
  root: string;
  /** Skill-directory path relative to `root` (e.g. `.claude/skills`). */
  skillsDir: string;
  slugs: ReadonlyArray<string>;
  /** Overwrite an existing SKILL.md instead of skipping it. */
  force: boolean;
  /** Compute results without writing anything. */
  dryRun: boolean;
  /** The version to stamp; the package's own by default. */
  version?: string;
}

/** Write each requested skill as `<skillsDir>/<slug>/SKILL.md`. Idempotent. */
export function installSkills(opts: InstallSkillsOptions): StepResult[] {
  const results: StepResult[] = [];
  for (const slug of opts.slugs) {
    const step = `skill:${slug}`;
    const source = templatePath(opts.templatesDir, slug);
    const relDest = path.join(opts.skillsDir, slug, 'SKILL.md');
    const dest = path.join(opts.root, relDest);

    if (!fs.existsSync(source)) {
      results.push({ step, status: 'error', detail: `no template found for "${slug}"` });
      continue;
    }

    const version = opts.version ?? readTemplatesVersion(opts.templatesDir);
    const contents = stampSkill(fs.readFileSync(source, 'utf-8'), version);
    const exists = fs.existsSync(dest);
    let detail = 'installed skill';
    if (exists) {
      const installed = fs.readFileSync(dest, 'utf-8');
      const state = classifyInstalledSkill(installed, contents);
      const from = readSkillStamp(installed).version;
      if (state === 'current') {
        results.push({ step, file: relDest, status: 'already', detail: `skill already installed (${version})` });
        continue;
      }
      if (state === 'outdated') {
        detail = `outdated (${from ?? 'unknown version'}) — updated to ${version}`;
      } else if (!opts.force) {
        results.push({
          step,
          file: relDest,
          status: 'skipped',
          detail:
            state === 'edited'
              ? `edited since ${from ?? 'it was'} installed — pass --force to replace it with ${version}`
              : `skill exists and differs — pass --force to replace it with ${version}`,
        });
        continue;
      } else {
        detail = state === 'edited' ? `edited — replaced with ${version}` : `replaced with ${version}`;
      }
    }

    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, contents);
    }
    results.push({ step, file: relDest, status: exists ? 'updated' : 'created', detail });
  }
  return results;
}

const USAGE = `
piwi skills — install the Piwi agent skills into this project

Usage:
  npx @piwitests/reporter skills list
  npx @piwitests/reporter skills add [names...] [options]

Commands:
  list              Show the available skills and what each one is for
  add [names...]    Install the named skills (default: all of them)

Options for "add":
  --dir <path>      Directory to install into (default: ${DEFAULT_SKILLS_DIR})
  --cwd <path>      Project root to operate on (default: current directory)
  --force           Replace a skill that was edited since it was installed
                    (an untouched skill from an older release is always updated)
  --dry-run         Report what would be written without writing
  --json            Print the results as JSON

Skills: ${ALL_SKILLS.join(', ')}
`.trim();

function readOption(argv: string[], name: string): string | undefined {
  const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

/** Slugs passed as positional args (everything before the first `--flag`). */
function positionalSlugs(argv: string[]): string[] {
  const slugs: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) break;
    slugs.push(arg);
  }
  return slugs;
}

/** Run `piwi skills`. Returns the process exit code rather than calling exit. */
export function runSkills(argv: string[], templatesDir: string, cwd: string = process.cwd()): number {
  const [sub, ...rest] = argv;

  if (sub === undefined || sub === '-h' || sub === '--help') {
    console.log(USAGE);
    return 0;
  }

  if (sub === 'list') {
    const infos = listSkills(templatesDir);
    if (rest.includes('--json')) {
      console.log(JSON.stringify(infos, null, 2));
    } else {
      console.log('Available Piwi skills:\n');
      for (const info of infos) console.log(`  ${info.slug}\n    ${info.description}\n`);
    }
    return 0;
  }

  if (sub === 'add') {
    const requested = positionalSlugs(rest);
    const unknown = requested.filter((slug) => !ALL_SKILLS.includes(slug as (typeof ALL_SKILLS)[number]));
    if (unknown.length) {
      console.error(`piwi skills: unknown skill(s): ${unknown.join(', ')}\n`);
      console.error(USAGE);
      return 2;
    }

    const results = installSkills({
      templatesDir,
      root: path.resolve(readOption(rest, '--cwd') ?? cwd),
      skillsDir: readOption(rest, '--dir') ?? DEFAULT_SKILLS_DIR,
      slugs: requested.length ? requested : ALL_SKILLS,
      force: rest.includes('--force'),
      dryRun: rest.includes('--dry-run'),
    });

    if (rest.includes('--json')) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const result of results)
        console.log(`  [${result.status}] ${result.file ?? result.step} — ${result.detail}`);
    }
    return results.some((r) => r.status === 'error') ? 2 : 0;
  }

  console.error(`piwi skills: unknown command "${sub}"\n`);
  console.error(USAGE);
  return 2;
}
