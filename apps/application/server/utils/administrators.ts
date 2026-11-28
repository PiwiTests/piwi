import { and, asc, eq, isNotNull, ne, or } from 'drizzle-orm';
import type { DrizzleDB } from '#shared/handlers/db';
import { InstanceRole } from '#shared/permissions';
import { users } from '../database/schema';

/** The administrators who can sign in and have an address: those an email about the instance goes to. */
export async function administratorEmails(db: DrizzleDB, exceptUserId?: number): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.role, InstanceRole.ADMINISTRATOR),
        isNotNull(users.email),
        or(ne(users.password, ''), isNotNull(users.oauthProvider)),
        exceptUserId === undefined ? undefined : ne(users.id, exceptUserId),
      ),
    )
    .orderBy(asc(users.id));
  return rows.map((row) => row.email!);
}
