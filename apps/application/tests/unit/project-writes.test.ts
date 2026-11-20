import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import { ProjectRole } from '#shared/permissions';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules (which import the barrel) are loaded.
delete process.env.PIWI_DATABASE_URL;
const { createProject, updateProject } = await import('../../shared/handlers/projects');
const { replaceProjectBindings, replaceSubjectBindings } = await import('../../shared/handlers/role-bindings');

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.tags).values([
    { id: 1, text: 'smoke' },
    { id: 2, text: 'nightly' },
  ]);
});

afterEach(() => close());

async function tagIdsOf(projectId: number) {
  const rows = await db
    .select({ tagId: schema.projectTags.tagId })
    .from(schema.projectTags)
    .where(eq(schema.projectTags.projectId, projectId));
  return rows.map((r) => r.tagId).sort();
}

async function projectRow(id: number) {
  const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  return row;
}

describe('createProject', () => {
  test('an unknown tag id is refused before the project is created', async () => {
    await expect(createProject(db as never, 'web', null, null, [1, 99])).rejects.toThrow(
      'One or more tag IDs are invalid',
    );
    expect(await db.select().from(schema.projects)).toEqual([]);
  });

  test('a repeated tag id links the tag once', async () => {
    const { project } = await createProject(db as never, 'web', null, null, [1, 1]);
    expect(await tagIdsOf(project.id)).toEqual([1]);
  });
});

describe('updateProject', () => {
  beforeEach(async () => {
    await db.insert(schema.projects).values({
      id: 7,
      name: 'web',
      label: 'Web',
      diagnosisInstructions: 'Prefer network evidence',
      scmToken: 'enc:stored',
    });
    await db.insert(schema.projectTags).values({ projectId: 7, tagId: 1 });
  });

  test('an unknown tag id changes nothing', async () => {
    await expect(updateProject(db as never, 7, { label: 'Renamed', tagIds: [2, 99] })).rejects.toThrow(
      'One or more tag IDs are invalid',
    );
    expect((await projectRow(7))?.label).toBe('Web');
    expect(await tagIdsOf(7)).toEqual([1]);
  });

  test('a repeated tag id replaces the tags with one link', async () => {
    await updateProject(db as never, 7, { tagIds: [2, 2] });
    expect(await tagIdsOf(7)).toEqual([2]);
  });

  test('null or an empty string clears the diagnosis instructions; omitting them keeps them', async () => {
    await updateProject(db as never, 7, { label: 'Web app' });
    expect((await projectRow(7))?.diagnosisInstructions).toBe('Prefer network evidence');

    await updateProject(db as never, 7, { diagnosisInstructions: null });
    expect((await projectRow(7))?.diagnosisInstructions).toBeNull();

    await updateProject(db as never, 7, { diagnosisInstructions: 'Check the API first' });
    await updateProject(db as never, 7, { diagnosisInstructions: '' });
    expect((await projectRow(7))?.diagnosisInstructions).toBeNull();
  });

  test('an omitted SCM credential keeps the stored one; null removes it', async () => {
    await updateProject(db as never, 7, { scmCredentialId: 3 });
    await updateProject(db as never, 7, { label: 'Web app', tagIds: [] });
    expect((await projectRow(7))?.scmCredentialId).toBe(3);

    const answer = await updateProject(db as never, 7, { scmCredentialId: null });
    expect((await projectRow(7))?.scmCredentialId).toBeNull();
    expect(answer.project).toMatchObject({ hasScmToken: false, scmCredentialId: null });
    expect(answer.project).not.toHaveProperty('scmToken');
  });
});

describe('project access writes', () => {
  beforeEach(async () => {
    await db.insert(schema.users).values([
      { id: 2, username: 'robin', password: '', role: 'member' },
      { id: 3, username: 'sam', password: '', role: 'member' },
    ]);
    await db.insert(schema.projects).values([
      { id: 5, name: 'api' },
      { id: 6, name: 'web' },
    ]);
  });

  async function bindings() {
    return db
      .select({
        userId: schema.roleBindings.userId,
        projectId: schema.roleBindings.projectId,
        role: schema.roleBindings.role,
      })
      .from(schema.roleBindings);
  }

  test('a repeated user in the member list is bound once, with its last role', async () => {
    await replaceProjectBindings(db as never, 5, [
      { subject: { userId: 2 }, role: ProjectRole.VIEWER },
      { subject: { userId: 2 }, role: ProjectRole.MAINTAINER },
      { subject: { userId: 3 }, role: ProjectRole.VIEWER },
    ]);
    expect(await bindings()).toEqual(
      expect.arrayContaining([
        { userId: 2, projectId: 5, role: 'maintainer' },
        { userId: 3, projectId: 5, role: 'viewer' },
      ]),
    );
    expect(await bindings()).toHaveLength(2);
  });

  test("a repeated project in a user's own roles is bound once", async () => {
    await replaceSubjectBindings(db as never, { userId: 2 }, [
      { projectId: 6, role: ProjectRole.VIEWER },
      { projectId: 6, role: ProjectRole.CONTRIBUTOR },
      { projectId: 5, role: ProjectRole.VIEWER },
      { projectId: null, role: ProjectRole.VIEWER },
    ]);
    expect(await bindings()).toHaveLength(3);
    expect(await bindings()).toContainEqual({ userId: 2, projectId: 6, role: 'contributor' });
  });
});
