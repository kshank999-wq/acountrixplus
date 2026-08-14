import { eq } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { users } from '@/db/schema'
import type { ActorContext } from '@/modules/tenancy/context'

/**
 * Who a scheduled task is.
 *
 * ## The problem
 *
 * Every service in this codebase takes an `ActorContext` whose `userId` is a
 * real row, and writes it to `created_by`, `posted_by`, `decided_by`, and the
 * audit log. A background job has no signed-in person, and there were three
 * ways to handle that, two of which are bad:
 *
 *  1. **Widen `userId` to null.** Fifty-eight call sites, several writing into
 *     `NOT NULL` columns, and every one of them would have to decide what a
 *     null means. The type that makes tenant isolation structural would get
 *     looser to serve the one caller that is not a person.
 *  2. **Attribute it to the company owner.** One line, and a lie. An owner who
 *     did not post that entry would find their name on it, which is precisely
 *     the thing an audit trail exists to prevent.
 *  3. **Give scheduled work a real identity.** One row, honest in the audit
 *     log, and every foreign key satisfied.
 *
 * This is the third.
 *
 * ## Why it cannot sign in
 *
 * The stored hash is a sentinel, not a hash. `verifyPassword` splits on `$`
 * and returns false unless it finds exactly six parts beginning with
 * `scrypt` — this string has one part, so verification returns false before
 * any comparison happens. There is no password that produces it because it is
 * not in the format a password could ever hash to.
 *
 * It is also a member of no company. `resolveSession` reads the membership,
 * so even a session minted for this id would resolve to nothing.
 *
 * `tests/worker.test.ts` asserts both, because "cannot sign in" is a claim
 * that has to be checked rather than believed.
 */

export const SYSTEM_USER_EMAIL = 'scheduled-task@accountrix.invalid'
export const SYSTEM_USER_NAME = 'Scheduled task'

/**
 * A value that is not a scrypt hash and cannot become one.
 *
 * `.invalid` in the email for the same reason: RFC 2606 reserves it precisely
 * so a fabricated address cannot collide with a real one somebody registers.
 */
const UNUSABLE_PASSWORD_HASH = 'system-actor-no-password'

/**
 * The system user, created once.
 *
 * `onConflictDoNothing` on the email rather than a read-then-write, so two
 * workers starting together produce one row instead of racing.
 */
export async function systemUserId(exec: Executor = db): Promise<string> {
  const inserted = await exec
    .insert(users)
    .values({
      email: SYSTEM_USER_EMAIL,
      name: SYSTEM_USER_NAME,
      passwordHash: UNUSABLE_PASSWORD_HASH,
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id })

  if (inserted.length > 0) return inserted[0].id

  const [existing] = await exec
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, SYSTEM_USER_EMAIL))
    .limit(1)

  return existing.id
}

/**
 * An actor for work nobody requested, scoped to one company.
 *
 * The role is `owner`, and that is deliberate rather than lazy. A scheduled
 * task acts *for the company* — it is not standing in for a member — and a
 * lesser role would mean a nightly job quietly doing less than the code it
 * replaced, failing in a way that looks like nothing happening.
 *
 * What actually limits a job is which handlers exist, and that is decided in
 * source at registration time rather than at runtime by a role. A permission
 * check would be checking the code against itself.
 */
export async function systemActor(companyId: string, exec: Executor = db): Promise<ActorContext> {
  return {
    userId: await systemUserId(exec),
    userName: SYSTEM_USER_NAME,
    companyId,
    role: 'owner',
    ipAddress: null,
    userAgent: null,
  }
}

/** True for the identity scheduled work runs as. */
export function isSystemActor(actor: { userName: string }): boolean {
  return actor.userName === SYSTEM_USER_NAME
}
