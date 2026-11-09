/**
 * The install stamps of a Piwi agent skill (`SKILL.md`): `piwi-version`, the
 * release the skill came from, and `piwi-hash`, a hash of the file as written.
 * Whoever installs a skill (`piwi skills add`, the desktop app) stamps it the
 * same way, so a later install tells an untouched skill from an older release
 * (outdated, safe to replace) from one a person changed (edited, kept).
 */

import { fnv1a32 } from './hash';

/** The front-matter keys of the stamps. */
export const SKILL_VERSION_KEY = 'piwi-version';
export const SKILL_HASH_KEY = 'piwi-hash';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Two FNV-1a passes with different seeds, as 16 hex characters: stable and dependency-free. */
function hash16(input: string): string {
  return fnv1a32(input) + fnv1a32(input, 0x01000193);
}

function withoutHashLine(markdown: string): string {
  return markdown.replace(new RegExp(`^${SKILL_HASH_KEY}:.*\\r?\\n`, 'm'), '');
}

/** The hash a skill file is stamped with: its content without the hash line itself. */
export function skillContentHash(markdown: string): string {
  return hash16(withoutHashLine(markdown).replace(/\r\n/g, '\n'));
}

/** A skill stamped with a version and the hash of the stamped file. A file with no front matter is left as is. */
export function stampSkill(template: string, version: string): string {
  const match = FRONT_MATTER.exec(template);
  if (!match) return template;
  const front = match[1]!
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(`${SKILL_VERSION_KEY}:`) && !line.startsWith(`${SKILL_HASH_KEY}:`));
  const versionLine = `${SKILL_VERSION_KEY}: ${version}`;
  const versioned = template.replace(match[0], () => `---\n${[...front, versionLine].join('\n')}\n---`);
  const hash = skillContentHash(versioned);
  return versioned.replace(`${versionLine}\n---`, () => `${versionLine}\n${SKILL_HASH_KEY}: ${hash}\n---`);
}

/** The stamps of a skill file, when it has them. */
export function readSkillStamp(markdown: string): { version: string | null; hash: string | null } {
  const lines = FRONT_MATTER.exec(markdown)?.[1]?.split(/\r?\n/) ?? [];
  const read = (key: string) => {
    const line = lines.find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() || null : null;
  };
  return { version: read(SKILL_VERSION_KEY), hash: read(SKILL_HASH_KEY) };
}

/**
 * What an installed skill is against the stamped skill on offer: `current`
 * (identical), `outdated` (untouched since another release installed it),
 * `edited` (changed by hand since it was installed) or `unstamped` (installed
 * without stamps, and different).
 */
export type InstalledSkillState = 'current' | 'outdated' | 'edited' | 'unstamped';

export function classifyInstalledSkill(installed: string, stamped: string): InstalledSkillState {
  if (installed.replace(/\r\n/g, '\n') === stamped.replace(/\r\n/g, '\n')) return 'current';
  const stamp = readSkillStamp(installed);
  if (!stamp.hash) return 'unstamped';
  return skillContentHash(installed) === stamp.hash ? 'outdated' : 'edited';
}
