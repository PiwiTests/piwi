import { describe, expect, it } from 'vitest';
import { classifyInstalledSkill, readSkillStamp, skillContentHash, stampSkill } from '../src/skill-stamp';

const SKILL = '---\nname: investigate-failure\ndescription: Investigate a failure.\n---\n\n# Investigate\n\nSteps.\n';

describe('skill stamps', () => {
  it('stamps the version and the hash of the stamped file into the front matter', () => {
    const stamped = stampSkill(SKILL, '0.46.0');
    expect(stamped).toMatch(
      /^---\nname: investigate-failure\ndescription: Investigate a failure\.\npiwi-version: 0\.46\.0\npiwi-hash: [0-9a-f]{16}\n---\n/,
    );
    const stamp = readSkillStamp(stamped);
    expect(stamp.version).toBe('0.46.0');
    expect(stamp.hash).toBe(skillContentHash(stamped));
  });

  it('restamps an already stamped skill in place', () => {
    const twice = stampSkill(stampSkill(SKILL, '0.45.0'), '0.46.0');
    expect(twice).toBe(stampSkill(SKILL, '0.46.0'));
  });

  it('leaves a file without front matter alone', () => {
    expect(stampSkill('# No front matter', '0.46.0')).toBe('# No front matter');
  });

  it('tells current, outdated, edited and unstamped skills apart', () => {
    const current = stampSkill(SKILL, '0.46.0');
    const older = stampSkill(SKILL.replace('Steps.', 'Old steps.'), '0.45.0');
    expect(classifyInstalledSkill(current, current)).toBe('current');
    expect(classifyInstalledSkill(current.replace(/\n/g, '\r\n'), current)).toBe('current');
    expect(classifyInstalledSkill(older, current)).toBe('outdated');
    expect(classifyInstalledSkill(older.replace('Old steps.', 'My own steps.'), current)).toBe('edited');
    expect(classifyInstalledSkill(SKILL, current)).toBe('unstamped');
  });

  it('hashes a skill to the same 16 hex characters across releases', () => {
    expect(skillContentHash('---\nname: piwi\npiwi-version: 1.0.0\n---\n# Piwi\n')).toBe('b3067d002c26410a');
  });
});
