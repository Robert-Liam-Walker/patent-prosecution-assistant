// Single-user stub. Returns a stable hardcoded user id so all data
// is owned by "the user." When swapping in Auth.js v5, replace this
// with `auth()` from `@/auth` and update callers — schemas already
// FK to users.id so no migration needed.

import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export const SINGLE_USER_EMAIL = "you@local";

let cachedUserId: string | null = null;

export async function getCurrentUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, SINGLE_USER_EMAIL))
    .limit(1);

  if (existing.length > 0) {
    cachedUserId = existing[0].id;
    return cachedUserId;
  }

  const [created] = await db
    .insert(schema.users)
    .values({ email: SINGLE_USER_EMAIL })
    .returning({ id: schema.users.id });

  cachedUserId = created.id;
  return cachedUserId;
}
