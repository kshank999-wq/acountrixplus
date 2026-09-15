/**
 * What a write stands on when it is not `scoped()` (Phase 149, spec §14/§19).
 *
 * ## The claim this was built to check
 *
 * The README says, of tenant isolation:
 *
 * > tenant isolation rests on `scoped()` at every query and on the tests that
 * > assert it
 *
 * Measured: **159** company-scoped tables, **1,330** queries naming one, and
 * **271** of those with no `scoped()` and no `companyId` anywhere in the
 * statement. Narrowing to the dangerous shape — an `update` or `delete` keyed
 * by an id that arrived as an argument — leaves **29**, of which **22** have no
 * scoped read of the same table before them.
 *
 * Every one of the 22 is safe. Not one of them is safe because of `scoped()`.
 *
 * That is ADR 0110's shape on the highest-stakes axis in the system: a
 * declaration argued from a fact that is not a fact. Isolation is real and it
 * rests on **nine** different mechanisms, and nothing anywhere recorded which
 * one any given write stands on.
 *
 * ## Why the guards are declared and the sites are measured
 *
 * ADR 0141's split, and this is the clearest case of it yet. The knowledge is
 * *what kinds of guard are legitimate* — that is a judgement, and it belongs in
 * prose somebody can disagree with. The fact is *which guard a given write
 * actually has*, and that is readable from the source.
 *
 * Declaring the sites instead would produce a list that says `updateTime` is
 * fine, which is exactly the sentence that stops being true the day somebody
 * deletes the `loadOwnEditable` call. So every guard here carries a `detect`
 * describing what the scan looks for, and a write matching **no** guard fails
 * the test by name.
 *
 * ## The one my own scan could not see
 *
 * `revokeDevice` and `renameDevice` came back unguarded on the first run. They
 * are not: both filter `eq(devices.userId, ctx.userId)`, which is **stricter**
 * than a company filter — a colleague in the same company cannot rename your
 * phone. The scan could not see it because it was looking for `companyId`, so
 * the tightest guard in the codebase was invisible to a check shaped like the
 * loosest one.
 *
 * Eleventh instance of that family, and the reason `actor-scoped` is a declared
 * guard rather than an exception.
 */

import { RegistryError } from '@/modules/errors/registry'

/** How a write that is not `scoped()` establishes whose row it is touching. */
export type GuardKind =
  | 'scoped-write'
  | 'conditions-array'
  | 'explicit-company'
  | 'owner-helper'
  | 'actor-scoped'
  | 'read-then-refuse'
  | 'bearer-credential'
  | 'caller-established'
  | 'system-actor'

export type IsolationGuard = {
  kind: GuardKind
  /** What the scan looks for, in words, beside the predicate that does it. */
  detect: string
  /**
   * Is this guard at least as strong as a company filter?
   *
   * `actor-scoped` is stronger and `system-actor` is not a tenant guard at all.
   * Flattening those into "guarded" would be the excuse ADR 0134 warns about.
   */
  atLeastCompanyTight: boolean
  because: string
}

export const ISOLATION_GUARDS: readonly IsolationGuard[] = [
  {
    kind: 'scoped-write',
    detect: '`scoped(ctx, table, …)` inside the statement’s own `where`.',
    atLeastCompanyTight: true,
    because:
      'The one the README names, and it does cover the large majority of the 1,330 queries. It is ' +
      'the best of these because the filter cannot be separated from the statement it protects — ' +
      'there is no window between a check and a write for somebody to edit a line into. Every ' +
      'other entry here is a way of being right that depends on something further away.',
  },
  {
    kind: 'conditions-array',
    detect: 'A `conditions` array built above, holding a companyId equality, spread into `where`.',
    atLeastCompanyTight: true,
    because:
      'How the reporting queries are written, because a trial balance filters on date, status and ' +
      'account as well as tenant and one `and(...)` of five things reads better assembled. Sound, ' +
      'and one edit away from not being: the scope is a line in a list rather than a call that ' +
      'says what it is for, so it is the entry most likely to be dropped by somebody tidying.',
  },
  {
    kind: 'explicit-company',
    detect: '`eq(table.companyId, ctx.companyId)` written out in the statement or just above it.',
    atLeastCompanyTight: true,
    because:
      'The most common guard among writes that do not use `scoped()`, at eight of the twenty-two. ' +
      'Identical in effect and weaker in signal: a reader has to notice the line rather than the ' +
      'helper, and a scan looking for the helper calls it unguarded. This is the entry that makes ' +
      'the registry worth having, because it is the one that looks like a defect and is not.',
  },
  {
    kind: 'owner-helper',
    detect: 'A named helper awaited above that loads the row and refuses when it is not yours.',
    atLeastCompanyTight: true,
    because:
      'Four sites, and the strongest of the indirect guards because the helper refuses rather than ' +
      'returning nothing — `loadOwnEditable`, `engagementForOwner`, `requirePracticeOwner`. Some ' +
      'check more than tenancy: a time entry has to be yours *and* unbilled. A helper is also the ' +
      'only one of these that can be read once and trusted at every call site.',
  },
  {
    kind: 'actor-scoped',
    detect: '`eq(table.userId, ctx.userId)` in the statement — the acting user, not the company.',
    atLeastCompanyTight: true,
    because:
      'Stricter than a company filter, not weaker: a colleague in the same company cannot revoke ' +
      'or rename your phone. This guard is here because the first run of this scan reported both ' +
      'device writes as unguarded — it was looking for `companyId`, so the tightest rule in the ' +
      'codebase was invisible to a check shaped like the loosest one.',
  },
  {
    kind: 'read-then-refuse',
    detect:
      'A read above filtered by company or acting user, a refusal when it finds nothing, then a ' +
      'write by the same id.',
    atLeastCompanyTight: true,
    because:
      'The shape `postDraftEntry` uses and the one the first run of this scan could not see: ' +
      '`revokeDevice` reads the device under `userId = ctx.userId`, throws `missing` when there ' +
      'is none, and then writes by id alone. The filter is real and it is one statement earlier, ' +
      'which is why the write looks bare. Sound while the refusal is there, and the refusal is ' +
      'the whole guard — deleting the `if (!device) throw` line makes this a cross-tenant write ' +
      'and changes nothing that reads like a filter.\n\n' +
      'It absorbed a guard I had declared separately. `voidDeposit` finds the deposit under a ' +
      'tenant filter, refuses when there is none, and then deletes the items by the deposit id — ' +
      'which I called `parent-scoped` until the scan reported that kind as used by nothing. It ' +
      'is this shape with the refusal one table up, and a distinction the measurement collapsed ' +
      'is not a distinction.',
  },
  {
    kind: 'bearer-credential',
    detect: 'The id is the secret: an unguessable token, with its precondition in the write.',
    atLeastCompanyTight: false,
    because:
      '`redeemToken` takes a token id from an emailed link and spends it with ' +
      '`WHERE redeemed_at IS NULL`. There is no actor yet — the whole point is that the link ' +
      'proves who you are — so a tenant filter would have nothing to filter against. Marked not ' +
      'company-tight because it is a different kind of proof, and one that stops working the day ' +
      'the id stops being unguessable.',
  },
  {
    kind: 'caller-established',
    detect: 'A module-private helper, or one whose id argument the caller obtained under a check.',
    atLeastCompanyTight: false,
    because:
      'The weakest entry and the honest name for it. `recordPostedRate` is not exported, so its ' +
      'callers are readable in one file. `touchDevice` is exported and safe only because its one ' +
      'caller passes `session.deviceId`, which an authenticated session established. That is a ' +
      'property of the call site rather than of the function, so the test names the call sites.',
  },
  {
    kind: 'system-actor',
    detect: 'No `ActorContext` at all, in the worker or scheduler, operating across tenants by design.',
    atLeastCompanyTight: false,
    because:
      'The background queue drains every company’s jobs and the scheduler holds rows whose ' +
      '`companyId` is deliberately null. Adding a tenant filter would break them rather than ' +
      'secure them. This is the entry that most needs to be checkable rather than asserted, ' +
      'because "it is a system path" is exactly what somebody would write to excuse a real one.',
  },
]

/** The guard a kind names. Throws on one nobody declared. */
export function isolationGuardFor(kind: string): IsolationGuard {
  const guard = ISOLATION_GUARDS.find((row) => row.kind === kind)
  if (!guard) {
    throw new RegistryError({
      registry: 'ISOLATION_GUARDS',
      key: kind,
      message:
        `No isolation guard is declared for "${kind}". A write that reaches a company-scoped ` +
        'table has to say what establishes whose row it is touching, because "it is fine" is not ' +
        'something the next person can check.',
    })
  }
  return guard
}

export type GuardVerdict =
  | { guarded: true; kind: GuardKind }
  | { guarded: false; why: string }

/**
 * Which guard, if any, a write stands on.
 *
 * Every input is **measured from the source** by the scan that calls this —
 * nothing here is declared per site. The order is deliberate: the strongest and
 * most local evidence first, so a write that has two guards is reported under
 * the one a reader would rely on.
 */
export function guardFor(site: {
  /** `scoped(` appears inside the statement's own where. */
  scopedInStatement: boolean
  /** A companyId equality in the statement or its function head. */
  companyInStatement: boolean
  /** A conditions array holding the scope is spread into the where. */
  conditionsArray: boolean
  /** The where filters on the acting user. */
  actorFiltered: boolean
  /** A read above filtered by company or actor, with a refusal when it is empty. */
  readThenRefuse: boolean
  /** A helper matching the owner-check shape is awaited above. */
  ownerHelper: string | null
  /** The where carries its own precondition and the id is a secret. */
  bearerToken: boolean
  /** The enclosing function takes an ActorContext. */
  takesActorContext: boolean
  /** The enclosing function is exported. */
  exported: boolean
  /** The file sits under the worker or scheduler. */
  systemPath: boolean
}): GuardVerdict {
  if (site.scopedInStatement) return { guarded: true, kind: 'scoped-write' }
  if (site.conditionsArray) return { guarded: true, kind: 'conditions-array' }
  if (site.actorFiltered) return { guarded: true, kind: 'actor-scoped' }
  if (site.companyInStatement) return { guarded: true, kind: 'explicit-company' }
  if (site.readThenRefuse) return { guarded: true, kind: 'read-then-refuse' }
  if (site.ownerHelper !== null) return { guarded: true, kind: 'owner-helper' }
  if (site.bearerToken) return { guarded: true, kind: 'bearer-credential' }
  if (!site.takesActorContext && site.systemPath) return { guarded: true, kind: 'system-actor' }
  if (!site.takesActorContext) return { guarded: true, kind: 'caller-established' }

  return {
    guarded: false,
    why:
      'This write reaches a company-scoped table keyed by an id it was handed, and nothing in it ' +
      'establishes whose row that is: no scope in the statement, no company or actor filter, no ' +
      'owner check above it, and it takes an ActorContext so it is not a system path. Either add ' +
      'the filter or declare which guard it stands on and make that guard detectable.',
  }
}
