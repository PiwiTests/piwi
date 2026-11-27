// The Piwi workflow skills this build ships (the same files `piwi skills add`
// installs), each stamped with this version, so the desktop app can install
// them into a project's linked folder.
import { stampSkill } from '@piwitests/core/skill-stamp';
import { SKILL_PROMPTS } from '#shared/mcp-prompts';
import { bundledSkill, splitSkill } from '../../utils/mcp/prompts';
import { requireAuth } from '../../utils/auth';
import { dashboardVersion } from '../../utils/app-version';

defineRouteMeta({
  openAPI: {
    tags: ['AI'],
    summary: 'List the workflow skills this build ships',
    description:
      'The Piwi workflow skills (investigate-failure, apply-locator-healing, …) bundled into this server, each as the `SKILL.md` text `piwi skills add` would write, stamped with this version (`piwi-version`) and the hash of the stamped file (`piwi-hash`). `items` is empty when the build carries no skills.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const version = dashboardVersion(event);
  const items = [];
  for (const [prompt, slug] of SKILL_PROMPTS) {
    const markdown = await bundledSkill(slug);
    if (!markdown) continue;
    items.push({ slug, prompt, description: splitSkill(markdown).description, content: stampSkill(markdown, version) });
  }
  return { version, items };
});
