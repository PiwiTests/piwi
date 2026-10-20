import { describe, test, expect } from 'vitest';
import { isJiraIconPath, jiraIconPath } from '../../server/utils/integrations/jira/icons';

const SITE = 'https://acme.atlassian.net';
const AVATAR = '/rest/api/2/universal_avatar/view/type/issuetype/avatar/10303?size=medium';

describe('Jira icon paths', () => {
  test('an icon on the site, relative, or through the gateway keeps its site path', () => {
    expect(jiraIconPath(`${SITE}${AVATAR}`, SITE)).toBe(AVATAR);
    expect(jiraIconPath(AVATAR, SITE)).toBe(AVATAR);
    expect(jiraIconPath(`https://api.atlassian.com/ex/jira/abc-123${AVATAR}`, SITE)).toBe(AVATAR);
    expect(jiraIconPath(`${SITE}/images/icons/issuetypes/bug.svg`, SITE)).toBe('/images/icons/issuetypes/bug.svg');
    expect(jiraIconPath(`${SITE}/secure/projectavatar?pid=10000&avatarId=10400`, SITE)).toBe(
      '/secure/projectavatar?pid=10000&avatarId=10400',
    );
  });

  test('an icon hosted elsewhere, or a path that is not an icon, is dropped', () => {
    expect(jiraIconPath(`https://evil.example${AVATAR}`, SITE)).toBeNull();
    expect(jiraIconPath(`${SITE}/rest/api/3/myself`, SITE)).toBeNull();
    expect(jiraIconPath(undefined, SITE)).toBeNull();
    expect(jiraIconPath('not a url ::', 'not a site')).toBeNull();
  });

  test('only icon paths are served, with no way out of them', () => {
    expect(isJiraIconPath(AVATAR)).toBe(true);
    expect(isJiraIconPath('/rest/api/3/myself')).toBe(false);
    expect(isJiraIconPath('/images/icons/../../rest/api/3/myself')).toBe(false);
    expect(isJiraIconPath('//evil.example/images/icons/x.svg')).toBe(false);
    expect(isJiraIconPath('https://evil.example/images/icons/x.svg')).toBe(false);
  });
});
