import type { RetentionKind } from './policy'

/**
 * Whose rows a retention policy is counting (Phase 102).
 *
 * ## The defect this exists to close
 *
 * `retentionReport()` took no company and the operations page that shows it is
 * per-company, so a `company:manage` holder at one company read how many
 * letters, campaign events, lead submissions and nightly check runs every
 * *other* company on the deployment was holding. Every other query on that page
 * takes `actor.companyId`; that one took nothing.
 *
 * The gate above it reasoned about which **role** may see the numbers and never
 * about **whose rows** they are. Those are different checks, and a permission
 * check reads like a complete one.
 *
 * ## Why three cases and not two
 *
 * "Has a `company_id` or does not" is the obvious model and the schema
 * disagrees. Two tables have one that is **nullable**, and the nulls are not
 * untidiness:
 *
 *  - a `password_reset` token carries a `userId` and no company, because when
 *    it is issued nobody knows which company the address belongs to;
 *  - a `practice_invitation` carries a `practiceId`, and a firm is not a
 *    company;
 *  - the Phase 88 morning brief writes a `transactional_messages` row whose
 *    audience is a practice.
 *
 * A plain `where company_id = $1` would close the leak and open a quieter hole:
 * those rows would become invisible to *everybody*, dropping out of the one
 * screen that answers "what do you hold, and for how long". So the third case
 * is named, and a company's count of those tables is described as its own share
 * rather than passed off as the total.
 *
 * ## This one is checked against the catalogue
 *
 * Unlike Phase 101's table count — "grows with traffic" is a fact about who
 * writes the rows, which no column says — **whether a table has a `company_id`,
 * and whether it is nullable, is a fact `information_schema.columns` holds.**
 * So these declarations are verified against the database rather than trusted,
 * the way Phase 96 verifies `PARTY_REFERENCES` against `pg_constraint`.
 *
 * The direction that earns its keep: making a column nullable is a migration
 * nobody would think to connect to a retention screen, and it silently turns a
 * complete count into a partial one.
 */

/**
 * The decision, and nothing else.
 *
 * Deliberately no column name here. `SWEEPS` in `sweep.ts` already holds the
 * typed column it filters on, and a second copy of the name in this file would
 * be two answers to "how is the company reached" — the defect this module
 * exists to fix, repeated one level down. This file says *whether* a company
 * can be named and *why not* when it cannot; `sweep.ts` says how; the
 * catalogue says what is actually there; and one test reconciles all three.
 */
export type Attribution =
  /** Every row belongs to exactly one company. The column is `NOT NULL`. */
  | { of: 'always_a_company' }
  /**
   * Some rows belong to a company and some to a person or a firm. `because`
   * says which, in words a person reads on a screen — Phase 70's rule that an
   * entry argues for itself rather than carrying a flag somebody else has to
   * interpret.
   */
  | { of: 'sometimes_a_company'; because: string }
  /** No company column at all. The rows are about people and this installation. */
  | { of: 'never_a_company'; because: string }

/** Who is asking. A screen has a company; the nightly sweep has nobody. */
export type Audience = { kind: 'company'; companyId: string } | { kind: 'deployment' }

/**
 * What a viewer may be shown for one policy.
 *
 * The policy itself — how long, and why — is *not* in here, deliberately. That
 * half is a published statement about the product and every viewer sees it.
 * Only the count is tenant data, and only the count is withheld.
 */
export type Showing =
  /** A number that is the whole truth for this viewer. */
  | { counted: true; whole: true }
  /** A number that is this viewer's own share, with the rest belonging elsewhere. */
  | { counted: true; whole: false; caveat: string }
  /** No number, and the reason instead of a blank. */
  | { counted: false; because: string }

export const ATTRIBUTIONS: Record<RetentionKind, Attribution> = {
  login_attempts: {
    of: 'never_a_company',
    because:
      'A sign-in attempt is keyed on an email address, because at sign-in time that is all ' +
      'anybody knows — not on a company, which is only settled once somebody is through.',
  },

  action_tokens: {
    of: 'sometimes_a_company',
    because:
      'An invitation to a company belongs to it. A password reset belongs to a person, and an ' +
      'invitation to a practice belongs to a firm — neither has a company on it.',
  },

  sessions: {
    of: 'never_a_company',
    because:
      'A session belongs to a person and to the device they signed in on. Somebody who belongs ' +
      'to two companies has one session across both.',
  },

  proposal_views: { of: 'always_a_company' },

  lead_submissions: {
    of: 'always_a_company',
  },

  campaign_events: {
    of: 'always_a_company',
  },

  transactional_messages: {
    of: 'sometimes_a_company',
    because:
      'Most letters are sent on behalf of a company. The morning brief goes to a firm about its ' +
      'clients (Phase 88) and has no company of its own.',
  },

  domain_events: {
    of: 'always_a_company',
  },

  orphaned_blobs: {
    of: 'never_a_company',
    because:
      'Content addressing means two companies uploading the same file share one blob, so the ' +
      'bytes are deliberately not attributable to either — the tenancy guarantee is the ' +
      '`documents` row and nothing else.',
  },

  integrity_runs: {
    of: 'always_a_company',
  },

  guard_attempts: {
    of: 'never_a_company',
    because:
      'A wrong password at a guarded act is about the person whose account it is (Phase 100). ' +
      'Somebody who belongs to two companies does not fumble a password at one of them.',
  },
}

export function attributionFor(kind: RetentionKind): Attribution {
  return ATTRIBUTIONS[kind]
}

/**
 * What this viewer may be shown for this policy.
 *
 * The deployment sees every count, because it is the only viewer for whom the
 * total is a true answer — and because the rows nobody can attribute to a
 * company are visible nowhere else.
 */
export function showingFor(attribution: Attribution, audience: Audience): Showing {
  if (audience.kind === 'deployment') return { counted: true, whole: true }

  switch (attribution.of) {
    case 'always_a_company':
      return { counted: true, whole: true }

    case 'sometimes_a_company':
      return {
        counted: true,
        whole: false,
        caveat: `This company's share. ${attribution.because}`,
      }

    case 'never_a_company':
      return {
        counted: false,
        because: `Not counted for one company. ${attribution.because}`,
      }
  }
}

/** Every policy whose rows a given company may be counted at all. */
export function countableFor(audience: Audience): RetentionKind[] {
  return (Object.keys(ATTRIBUTIONS) as RetentionKind[]).filter(
    (kind) => showingFor(ATTRIBUTIONS[kind], audience).counted,
  )
}
