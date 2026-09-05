import { RegistryError } from '@/modules/errors/registry'

/**
 * What the application keeps, for how long, and why (spec §19: "Backups,
 * point-in-time recovery strategy, **retention policy**, and tested restore
 * procedure").
 *
 * ## Why this is data rather than a set of `DELETE` statements
 *
 * Four phases have each left a retention job owed — Phase 13's
 * `login_attempts`, Phase 19's `action_tokens`, Phase 20's orphaned blobs,
 * Phase 10's finished jobs — and each was described in its own README bullet
 * with its own number in its own file. Written that way a fifth would be a
 * fifth bullet, and the question a data-protection request actually asks —
 * *what do you hold about me, and for how long* — would have no answer short
 * of reading every module.
 *
 * So the policies are a list. One place, one shape, and the sweeps are
 * generated from it.
 *
 * ## The allowlist is the safety property
 *
 * Every policy names exactly one table, and the list is the whole set of
 * tables anything in this module may delete from. Nothing here can reach the
 * ledger, the audit log, the documents, or any record of money — and
 * `tests/retention.test.ts` asserts that by name, so adding a policy for
 * `journal_lines` fails the suite rather than the year-end.
 *
 * That asymmetry is deliberate. These tables grow with *traffic* — much of it
 * from strangers on the internet, some of it at a rate an attacker chooses —
 * and none of them is evidence of anything a business owes or is owed.
 */

export type RetentionKind =
  | 'login_attempts'
  | 'action_tokens'
  | 'sessions'
  | 'proposal_views'
  | 'lead_submissions'
  | 'campaign_events'
  | 'transactional_messages'
  | 'domain_events'
  | 'orphaned_blobs'
  | 'integrity_runs'
  | 'guard_attempts'

export type RetentionPolicy = {
  kind: RetentionKind
  /** The one table this policy may delete from. */
  table: string
  label: string
  /** Null for the orphan sweep, which is a reachability question, not an age one. */
  days: number | null
  /**
   * True when rows arrive from unauthenticated strangers, which is what makes
   * the retention a control rather than tidiness.
   */
  publicallyWritten: boolean
  why: string
}

/**
 * The tables somebody has decided grow with traffic.
 *
 * That wording is load-bearing, and it replaces an earlier claim to name *every*
 * such table. The catalogue cannot tell you which tables grow with traffic —
 * `documents` and `domain_events` look identical to it and belong on opposite
 * sides of this list — so the honest statement is that this list is exactly as
 * complete as the last person to think about it. `guard_attempts` spent a phase
 * missing from it, under a docstring that read as authoritative.
 *
 * `tests/retention.test.ts` therefore counts the tables in the database and
 * fails when the number changes, so adding one is also the moment of deciding
 * whether it belongs here or in `NEVER_SWEPT`.
 *
 * The days are deliberately generous where the row still answers a question
 * somebody asks — a bounced invitation is worth seeing weeks later — and short
 * where the row is only ever evidence of a moment.
 */
export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  {
    kind: 'login_attempts',
    table: 'login_attempts',
    label: 'Sign-in attempts',
    days: 90,
    publicallyWritten: true,
    why:
      'Every failed sign-in on the internet writes a row and an attacker picks the rate. ' +
      'Ninety days keeps the lockout window and a quarter of history for an investigation, ' +
      'and throws away the part that is only ever a bill for disk.',
  },
  {
    kind: 'action_tokens',
    table: 'action_tokens',
    label: 'Password reset and invitation links',
    days: 30,
    publicallyWritten: true,
    why:
      'A reset lives an hour and an invitation a week (Phase 19). A month after that the row ' +
      'is a hashed secret nobody can use and nobody will ask about — and the safest place for ' +
      'a secret is not to hold it.',
  },
  {
    kind: 'sessions',
    table: 'sessions',
    label: 'Expired sessions',
    days: 30,
    publicallyWritten: false,
    why:
      'Signing out deletes the row; expiring does not. A month past expiry the row grants ' +
      'nothing and the device list has long stopped showing it.',
  },
  {
    kind: 'proposal_views',
    table: 'proposal_views',
    label: 'Views of a public proposal link',
    days: 365,
    publicallyWritten: true,
    why:
      'Anybody holding the link can write these, refresh included. A year keeps the ' +
      '"they read it three times before calling" that the sales dashboard is for.',
  },
  {
    kind: 'lead_submissions',
    table: 'lead_submissions',
    label: 'Rejected and duplicate lead submissions',
    days: 180,
    publicallyWritten: true,
    why:
      'The public intake endpoint. Accepted leads become opportunities and are not touched — ' +
      'this is the honeypot catches and rate-limit refusals, which are worth six months of ' +
      'pattern and nothing after.',
  },
  {
    kind: 'campaign_events',
    table: 'campaign_events',
    label: 'Marketing opens and clicks',
    days: 730,
    publicallyWritten: true,
    why:
      'Written by an image loading in somebody else\'s inbox. Two years, because ' +
      'year-on-year campaign comparison is a real question and the aggregate is small.',
  },
  {
    kind: 'transactional_messages',
    table: 'transactional_messages',
    label: 'Records of letters sent',
    days: 365,
    publicallyWritten: false,
    why:
      '"Did the mail go?" is asked days later, not years. A year is generous, and the ' +
      'communications log keeps the ones that mattered to a person (Phase 22) for ever.',
  },
  {
    kind: 'domain_events',
    table: 'domain_events',
    label: 'Relayed outbox events',
    days: 30,
    publicallyWritten: false,
    why:
      'Only rows that were actually relayed. An event still waiting is work in progress, ' +
      'never swept — the whole point of an outbox is that nothing is dropped on the floor.',
  },
  {
    kind: 'orphaned_blobs',
    table: 'document_blobs',
    label: 'File bytes nothing points at',
    days: null,
    publicallyWritten: false,
    why:
      'A crash between committing the row work and freeing the bytes leaves a blob no ' +
      'document references (Phase 20). Age is not the question; reachability is.',
  },
  {
    kind: 'integrity_runs',
    table: 'integrity_runs',
    label: 'What the nightly books check found',
    // A year, because the question this history exists to answer is "when did
    // this start", and a drift is often first noticed at a year end looking
    // back at something that happened in the spring. Ten rows a night is
    // nothing; losing the March run in October is the expensive outcome.
    days: 365,
    publicallyWritten: false,
    why:
      'A year of nightly results (Phase 33), kept so a difference discovered at a year end can ' +
      'be dated. Findings hang off the run and go with it — one policy, one table, and the ' +
      'foreign key does the rest.',
  },
  {
    kind: 'guard_attempts',
    table: 'guard_attempts',
    label: 'Wrong passwords at a guarded act',
    // A year, and longer than `login_attempts` above, which reads backwards
    // until you notice what ninety is doing there: the sign-in table is short
    // because anybody on the internet can write to it at a rate they choose,
    // and ninety days throws away the part that is only a bill for disk.
    //
    // Nothing here is written by a stranger. Reaching a guarded act needs a
    // live session, so the ceiling is one signed-in person's typing speed —
    // which leaves only the question the rows answer, and that one is asked
    // late. Same argument `integrity_runs` makes for its year.
    days: 365,
    publicallyWritten: false,
    why:
      'A wrong password at one of the four guarded acts (Phase 100), which only somebody already ' +
      'signed in can reach. A year, because the question is "was somebody at my session in March" ' +
      'and it is asked by somebody who has just found out something else is wrong — often with ' +
      'nothing to go on but a warning letter they half remember.',
  },
] as const

/**
 * Tables retention must never be able to reach.
 *
 * Not a mechanism — the allowlist above is the mechanism. This is the list the
 * test checks against, written down so the reason survives the person who
 * knew it: **none of these is traffic. Every one of them is evidence.**
 */
export const NEVER_SWEPT = [
  // The books. Spec §19: complete auditability of accounting changes.
  'journal_entries',
  'journal_lines',
  'invoices',
  'bills',
  'payments',
  'payment_applications',
  'bank_transactions',
  'chart_accounts',
  // Who did what, which is the record §19 exists to protect.
  'audit_events',
  // Evidence, and the notes an accountant left on it.
  'documents',
  'document_links',
  'document_bytes',
  'record_notes',
  // What was said and what was promised (Phase 22).
  'communications',
  'tasks',
  // Failures nobody has looked at yet. A dead job swept is a question
  // deleted before it was asked.
  'background_jobs',
] as const

export function policyFor(kind: RetentionKind): RetentionPolicy {
  const policy = RETENTION_POLICIES.find((entry) => entry.kind === kind)
  if (!policy) {
    // The eleventh registry lookup, and the one that was never in the
    // allowlist (Phase 132): its sentence is a fragment, so `audienceOf` read
    // it as an operator's and the rule about this device never asked.
    throw new RegistryError({
      registry: 'RETENTION_POLICIES',
      key: kind,
      message: `No retention policy named ${kind}`,
    })
  }
  return policy
}

/**
 * The instant a policy's rows stop being kept.
 *
 * `asOf` is a parameter rather than a clock read, the same rule Phase 16
 * applied to depreciation, Phase 21 to the PDF timestamp and Phase 23 to the
 * rent run. A sweep that reads the clock cannot be asked "what would you have
 * deleted last Tuesday", and cannot be asserted on.
 *
 * Null for policies whose question is not age.
 */
export function cutoffFor(policy: RetentionPolicy, asOf: Date): Date | null {
  if (policy.days === null) return null
  return new Date(asOf.getTime() - policy.days * 24 * 60 * 60 * 1000)
}

/** Days held, for a screen that has to answer "how long do you keep this?". */
export function retentionSummary(): Array<{
  kind: RetentionKind
  label: string
  days: number | null
  publicallyWritten: boolean
  why: string
}> {
  return RETENTION_POLICIES.map((policy) => ({
    kind: policy.kind,
    label: policy.label,
    days: policy.days,
    publicallyWritten: policy.publicallyWritten,
    why: policy.why,
  }))
}
