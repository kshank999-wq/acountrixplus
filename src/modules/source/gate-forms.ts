import { readFileSync } from 'node:fs'
import { RegistryError } from '@/modules/errors/registry'
import type { Permission } from '@/modules/permissions'
import { declarationOffset, enclosingSpan, withoutComments } from './enclosing'
import { sourceFiles } from './isolation-scan'

/**
 * The gate the scan could not read (spec §14, §19).
 *
 * ## What ADR 0213 claimed, and what it is
 *
 * Phase 213 built `audit-readers.ts` and asserted a property over it: **no role
 * produces an audit event it can never read.** The scan reads a site's gates
 * with one regular expression —
 *
 *     /requirePermission\(\s*\w+\s*,\s*'([a-z_]+:[a-z_]+)'/
 *
 * — and `blindProducers()` skips any site where that found nothing, on a stated
 * reason: *an ungated act names no producer and so blinds nobody.* ADR 0213
 * nominated the leftovers for this phase as **"44 write sites whose enclosing
 * function requires no permission at all"**, and asked which of four things each
 * one was: gated upstream in a server action, reached by a public token, run
 * from a worker, or not gated anywhere.
 *
 * Measured, that sentence is false and those categories are the wrong four.
 *
 * **Eleven of the forty-four do require a permission.** The regex wants a string
 * literal, and this codebase also writes a permission check three other ways:
 *
 * - a **soft** refusal — `if (!can(ctx, 'marketing:manage')) return { ok: false,
 *   … }`. All nine of these in `src/modules` are in the AI module, for a reason
 *   that is right: an assistant explains why it will not help, where a service
 *   throws.
 * - a permission **computed from the record's own kind** —
 *   `permissionFor(document.kind, 'manage')`, `subject.manage`,
 *   `assetSubjectFor(ref.kind).manage`. Tree-wide there are **30 computed
 *   checks against 795 literal ones**: one in twenty-seven, and no
 *   literal-matching scan will ever read any of them.
 * - a **ternary over two literals** — `revertImport`, which needs
 *   `bookkeeping:import` to undo a statement import and `accounting:journal` to
 *   undo anything else.
 *
 * And the nomination's own four:
 *
 * - **"gated upstream in a server action" cannot happen here.** `src/app` holds
 *   eleven `requirePermission` calls in three files, because the architecture
 *   puts business logic and its gates in `src/modules`. The category was a guess
 *   about a codebase this is not.
 * - **"from a worker" is empty.** Nothing among the 44 is reached from a job
 *   runner; the sweeps that look like it are reached from gated acts.
 * - a fifth form the nomination had no category for: the **practice** side has
 *   its own authority model. `requirePracticeOwner` is used eight times and is
 *   not a company permission at all, so `blindProducers` — which iterates
 *   `ROLE_NAMES` — has nothing to say about it.
 *
 * So the answer is nine forms, not four, and the fix is the registry ADR 0213
 * floated rather than the permissions it floated first.
 *
 * ## What that cost
 *
 * Nothing about the *code* was unsafe. Every one of the eleven is gated, and
 * most of the other thirty-three are gated by something that is not a
 * permission. What was wrong is the **property**: for those eleven a producing
 * role exists, `blindProducers()` was told there was none, and so nobody had
 * ever asked whether those producers can read what they write.
 *
 * One of them could not. All five asset subjects are managed under
 * `marketing:manage`; `asset` was not in `READABLE_BY`, so its history needed
 * `audit:view`; and `marketing` holds the first and not the second. **A marketer
 * could associate an asset with a campaign, detach it again, and read the
 * history of neither act.** That is the exact defect Phase 213 built a property
 * to forbid, sitting inside the gap the property's own reader left — ADR 0134's
 * shape appearing in the device written to avoid it.
 *
 * ## Why this is a registry and not a deeper scan
 *
 * The obvious repair is to follow the calls: resolve gates transitively and the
 * problem goes away. It does not. A transitive scan over-collects in a way it
 * cannot detect, because it cannot tell a refusal that **blocks the act** from a
 * refusal the act **tolerates**. `transactionContext` returning `null` for a
 * reader without `bookkeeping:view` stops `suggestCategory` dead; another helper
 * returning `null` on the same check merely omits a paragraph from a prompt. The
 * two are identical in source and opposite in meaning, so a scan that counted
 * both would hand back confident numbers that are wrong in both directions.
 *
 * What a scan *can* check is a claim somebody made. So the five computed
 * expressions resolve through `GATE_RESOLVERS`, and every act with no check of
 * any form declares its reason in `OPEN_ACTS` — with a consequence that can be
 * falsified per category, which is Phase 116's rule: a scan that reports a
 * symbol must be checkable.
 *
 * Nothing here touches the database or the clock.
 */

/** How an act is authorised. Nine forms; the nomination guessed four. */
export type GateForm =
  /** `requirePermission(ctx, 'literal')` — what Phase 213's scan reads. */
  | 'literal'
  /** `if (!can(ctx, 'literal'))` and a refusal rather than a throw. */
  | 'soft'
  /** The permission is chosen from the record's own kind. */
  | 'computed'
  /** The blocking check is inside a function the act calls. */
  | 'delegated'
  /** The subject of the act is the actor; `ctx.userId` is the constraint. */
  | 'self'
  /** No actor exists — a bearer token stands in for one. */
  | 'token'
  /** No company exists yet to hold a permission in. */
  | 'bootstrap'
  /** Not reachable from `src/app`; its callers are gated acts. */
  | 'internal'
  /** Authorised by the practice relationship, not by a company role. */
  | 'practice'

/**
 * The permissions a computed gate can resolve to.
 *
 * Measured rather than assumed: across all 254 audit-writing functions there are
 * exactly **five** distinct computed check expressions, which is what makes a
 * register of them honest rather than a sample. An entry lists every permission
 * its expression can yield, so a reader of the scan can check the claim against
 * the resolver without re-deriving it.
 *
 * ## Five was the count for that population, and it read as the count (Phase 218)
 *
 * The sentence above is true and its scope is invisible one line later. Phase 217
 * built a second scan over a **different** population — 329 server actions and
 * everything they reach — and the tree holds **20** distinct computed check
 * expressions, not five. The eleven this phase adds are not new code; they are
 * the fifteen minus the four that were never gates at all, which
 * `permissionChecksIn` reported because `functionBody` handed it the signature.
 *
 * What made that survivable, and so invisible, was the other half: `gatesIn` in
 * `action-gates.ts` caught `resolveComputedGate`'s refusal and substituted
 * `company:manage`. So an undeclared expression did not fail — it answered, with
 * a real permission, in the same list and the same type as a permission that had
 * actually been read. **34 acts reported `company:manage`; 23 held it and 11 were
 * told they did.** `mergeParties` was reported owner-only when a manager may
 * merge two customers and an accountant two suppliers.
 *
 * The refusal below was written so that nothing could guess — *"guessing would
 * answer that question wrongly in silence, which is the defect Phase 214 exists
 * to stop."* Its only caller caught it and guessed. The repair is not a better
 * sentinel: it is to complete the register so the refusal is reachable again,
 * and to delete the catch, so the next undeclared expression stops the suite
 * instead of being answered.
 *
 * A set means **any one of them**, not all: the act is reachable for the kinds
 * the role manages. A person who may manage marketing documents and not
 * proposals still performs `saveDocument`, on marketing documents.
 */
export const GATE_RESOLVERS: Record<string, { yields: readonly Permission[]; why: string }> = {
  "permissionFor(document.kind, 'manage')": {
    yields: ['marketing:manage', 'proposals:manage'],
    why:
      '`permissionFor` in `design/documents.ts` is one line — marketing documents ' +
      'answer to marketing, everything else to proposals. Both are "manage" here ' +
      'because every one of these acts changes the document.',
  },
  "permissionFor(source.kind, 'manage')": {
    yields: ['marketing:manage', 'proposals:manage'],
    why:
      'The same resolver, reading the kind of the document being copied rather ' +
      'than the one being written. `duplicateDocument` is the only caller that ' +
      'names a source, and a copy inherits its original’s kind.',
  },
  'subject.manage': {
    yields: ['marketing:manage'],
    why:
      '`linkAsset` resolves the subject first and then gates on it. All five ' +
      'entries in `ASSET_SUBJECTS` declare `manage: marketing:manage` — a campaign, ' +
      'a contact, an organisation, an opportunity and a customer — so the set has ' +
      'one member today. It is written as a resolver and not as a literal because ' +
      'the sixth subject is the one that would differ, and then the scan should ' +
      'notice rather than keep reporting the old answer.',
  },
  'assetSubjectFor(ref.kind).manage': {
    yields: ['marketing:manage'],
    why:
      '`unlinkAsset`, the other half of the same pair, resolving from a stored ' +
      'link rather than from an argument. Detaching is gated exactly as attaching ' +
      'is, which is the property worth having and was not checkable before.',
  },
  "subject?.kind === 'bank_statement' ? 'bookkeeping:import' : 'accounting:journal'": {
    yields: ['bookkeeping:import', 'accounting:journal'],
    why:
      'Undoing an import means undoing what it wrote. A statement import wrote ' +
      'bank transactions, so it takes the permission that brought them in; ' +
      'anything else wrote journal entries, so it takes the ledger. The gate ' +
      'follows the damage, which is why it cannot be a literal.',
  },

  /* ---- Phase 218 ------------------------------------------------------- *
   * Everything below was already a computed gate in the tree and already
   * being answered with an invented `company:manage`. Declaring them is what
   * lets the catch in `gatesIn` go. Each `yields` is read off the registry the
   * expression consults, not off the call site.                             */

  /**
   * Evidence and notes, whose gate is the permission of whatever the document
   * is attached to. `SUBJECTS` in `evidence/subjects.ts` declares a `view` and
   * a `manage` per subject, and these are the distinct values across all of
   * them — a bank transaction answers to bookkeeping, an invoice to the ledger,
   * a payroll run to payroll, an organisation to the CRM.
   *
   * Five acts were reported as owner-only on this expression:
   * `uploadEvidence`, `attachExisting`, `detachEvidence`, `writeNote` and
   * `resolveNote`. `uploadEvidence` is the act Phase 214 found checking *late*
   * — it looked straight at it and still did not declare its resolver, because
   * the invented answer was indistinguishable from a read one.
   */
  'subjectDefinition(input.subjectType).manage': {
    yields: [
      'bookkeeping:categorize',
      'accounting:journal',
      'reconciliation:perform',
      'payroll:manage',
      'crm:manage',
      'proposals:manage',
    ],
    why:
      'The permission of the record the document is attached to, from `SUBJECTS` ' +
      'in `evidence/subjects.ts`. Attaching evidence to a thing is gated as ' +
      'changing that thing is, which is why it cannot be a literal: the subject ' +
      'arrives as an argument.',
  },
  'subjectDefinition(note.subjectType).manage': {
    yields: [
      'bookkeeping:categorize',
      'accounting:journal',
      'reconciliation:perform',
      'payroll:manage',
      'crm:manage',
      'proposals:manage',
    ],
    why:
      'The same resolver, reading the subject off a stored note rather than off ' +
      'an argument. `resolveNote` closes a note somebody else opened, so the ' +
      'subject comes from the row.',
  },
  'subjectDefinition(subjectType).view': {
    yields: [
      'bookkeeping:view',
      'accounting:view',
      'reconciliation:view',
      'payroll:view',
      'crm:view',
      'proposals:view',
    ],
    why:
      'The reading half of the same registry, for the counts and list queries ' +
      '(`evidenceCounts`, `notesForMany`). You may see what is attached to a ' +
      'record you may see.',
  },
  'subjectDefinition(ref.subjectType).view': {
    yields: [
      'bookkeeping:view',
      'accounting:view',
      'reconciliation:view',
      'payroll:view',
      'crm:view',
      'proposals:view',
    ],
    why:
      'The same registry, resolving from a stored reference rather than a bare ' +
      'kind — `notesFor` and `evidenceFor` take a subject reference. Same ' +
      'lookup, different spelling, and the scan matches the expression as ' +
      'written rather than the function it calls.',
  },
  'subjectDefinition(subject).view': {
    yields: [
      'bookkeeping:view',
      'accounting:view',
      'reconciliation:view',
      'payroll:view',
      'crm:view',
      'proposals:view',
    ],
    why:
      'The same, where the argument is already the subject rather than its ' +
      'type. Three spellings of one lookup, and the register names all three ' +
      'because the scan matches the expression as written.',
  },

  /**
   * Merging two parties, and the sharpest of the eleven.
   *
   * Reported as `company:manage` — owner only — while the code gates a customer
   * merge on `crm:manage` and a supplier merge on `accounting:journal`. So the
   * register said the owner alone could merge two records, when a **manager**
   * can merge two customers and an **accountant** two suppliers. A merge is
   * irreversible, which is exactly the kind of act a register of gates exists
   * to be right about.
   */
  "input.side === 'customer' ? 'crm:manage' : 'accounting:journal'": {
    yields: ['crm:manage', 'accounting:journal'],
    why:
      'A merge is gated by the side being merged: customers answer to the CRM, ' +
      'suppliers to the ledger. The same shape as `revertImport` below — the ' +
      'gate follows what the act touches, so it cannot be a literal.',
  },

  /**
   * Assets, the reading half of the pair already declared above.
   */
  'assetSubjectFor(ref.kind).view': {
    yields: ['crm:view', 'marketing:view'],
    why:
      '`ASSET_SUBJECTS` declares `view` as `crm:view` for the four CRM subjects ' +
      'and `marketing:view` for a campaign. Seeing which assets went to a record ' +
      'is gated as seeing the record is.',
  },
  'assetSubjectFor(kind).view': {
    yields: ['crm:view', 'marketing:view'],
    why:
      'The reading half again, from a bare kind rather than a stored link. ' +
      '`assetsForKind` lists what is attached to a kind of record before any ' +
      'particular record is chosen, so there is no link row to read the kind ' +
      'off — which is why this is a third spelling and not a duplicate.',
  },

  /**
   * Documents, the reading half of `permissionFor`.
   */
  "permissionFor(document.kind, 'view')": {
    yields: ['marketing:view', 'proposals:view'],
    why:
      'The resolver already declared for `manage`, asked for `view`. ' +
      '`getDocument` serves both the proposal editor and the creative studio.',
  },
  "permissionFor(kind ?? 'proposal', 'view')": {
    yields: ['marketing:view', 'proposals:view'],
    why:
      'The same, for a list query where the kind is optional and a missing one ' +
      'means proposals — the default the screen was built for.',
  },

  /**
   * One section of the accountant's package, gated by the permission that opens
   * the data in it.
   *
   * The twentieth expression, and the one the fixed `functionBody` found that
   * the broken one could not: `mayRead` is a local arrow inside `assemble`, so
   * reading the enclosing body correctly is what surfaced it. A soft check
   * (`can`, not `requirePermission`) because a section the reader may not see is
   * **omitted and recorded as omitted** rather than failing the package — which
   * is Phase 215's distinction, and the reason this one is a gate on a part of
   * the answer rather than on the act.
   */
  'section.source.permission': {
    yields: [
      'bookkeeping:view',
      'accounting:view',
      'reconciliation:view',
      'payroll:view',
      'tax:view',
      'reports:view',
      'reports:financial',
    ],
    why:
      'Every `permission` declared on a section source in the exporter registry. ' +
      'A section is readable by whoever may read the data it is made of, so the ' +
      'gate is the registry entry rather than one permission for the package.',
  },

  /**
   * One record's history, gated by the permission that opens that kind of
   * record (Phase 71's rule, Phase 213's register).
   *
   * The widest of the eleven, because `READABLE_BY` is wide: every permission
   * any entity type names, plus `audit:view` for a type nobody has placed. The
   * breadth is the point — `historyFor` is one function serving forty record
   * kinds, and a literal would have to be the strictest of them.
   */
  'permissionToRead(entityType)': {
    yields: [
      'bookkeeping:view',
      'accounting:view',
      'crm:view',
      'marketing:view',
      'jobs:view',
      'payroll:view',
      'reconciliation:view',
      'tax:view',
      'ai:use',
      'audit:view',
    ],
    why:
      'Every permission `READABLE_BY` in `audit/visibility.ts` names, plus the ' +
      '`audit:view` fall-through for an entity type nobody has placed. The ' +
      'register is the resolver: a record you may read, you may read the ' +
      'history of.',
  },
}

/** The permissions a computed check can yield, or a refusal naming the expression. */
export function resolveComputedGate(expression: string): readonly Permission[] {
  const found = GATE_RESOLVERS[expression]
  if (found) return found.yields

  throw new RegistryError({
    registry: 'GATE_RESOLVERS',
    key: expression,
    message:
      `No resolver is declared for the permission check \`${expression}\`. A gate whose ` +
      'permission is computed cannot be read off the source, so the audit scan cannot ' +
      'tell whether the roles that perform this act can read what it writes — and ' +
      'guessing would answer that question wrongly in silence, which is the defect ' +
      'Phase 214 exists to stop. Add an entry naming every permission the expression ' +
      'can yield, and say why it is computed rather than fixed.',
  })
}

/** An act with no permission check of any form, and the reason it needs none. */
export type OpenAct = {
  /** Repository-relative path. */
  file: string
  /** The top-level function. */
  symbol: string
  category: Extract<GateForm, 'delegated' | 'self' | 'token' | 'bootstrap' | 'internal' | 'practice'>
  /**
   * For `delegated` and `practice`: the function that actually refuses. Checked
   * against the source, so the claim cannot rot into prose.
   */
  gatedBy?: string
  why: string
}

/**
 * Every act that writes an audit event behind no permission check at all.
 *
 * Thirty-two functions. Each one has a reason and each reason has a consequence
 * a test can falsify — see `miscategorisedActs`. The register exists because the
 * alternative is the one Phase 213 shipped: a `continue` statement standing in
 * for thirty-two separate arguments nobody had made.
 */
export const OPEN_ACTS: readonly OpenAct[] = [
  // --- self: the actor is the subject ------------------------------------
  //
  // A permission is the wrong instrument for these, not a missing one. There is
  // no role that may not change its own password, and inventing
  // `security:self` would mean an owner could revoke it and lock somebody out
  // of their own account. The constraint that matters is `ctx.userId`, and that
  // is what the category is checked against.
  {
    file: 'src/app/actions/security.ts',
    symbol: 'confirmMfaEnrollmentAction',
    category: 'self',
    why: 'Finishes enrolling the actor’s own second factor, against their own secret.',
  },
  {
    file: 'src/app/actions/security.ts',
    symbol: 'disableMfaAction',
    category: 'self',
    why: 'Turns off the actor’s own second factor, after re-proving the password.',
  },
  {
    file: 'src/app/actions/security.ts',
    symbol: 'regenerateRecoveryCodesAction',
    category: 'self',
    why: 'Reissues the actor’s own recovery codes; nobody else can see them.',
  },
  {
    file: 'src/modules/auth/mfa.ts',
    symbol: 'changePassword',
    category: 'self',
    why:
      'Requires the current password, which is the only credential that matters ' +
      'here. A role grant would be both redundant and revocable.',
  },
  {
    file: 'src/modules/mobile/devices.ts',
    symbol: 'revokeDevice',
    category: 'self',
    why: 'Scoped to `devices.userId = ctx.userId`, so the only reachable device is the actor’s.',
  },
  {
    file: 'src/modules/mobile/devices.ts',
    symbol: 'revokeAllOtherDevices',
    category: 'self',
    why: 'Ends the actor’s own other sessions — the "sign out everywhere" that follows a scare.',
  },
  {
    file: 'src/modules/mobile/notifications.ts',
    symbol: 'subscribe',
    category: 'self',
    why: 'Registers a push endpoint against the actor’s own user row.',
  },
  {
    file: 'src/modules/mobile/notifications.ts',
    symbol: 'unsubscribe',
    category: 'self',
    why: 'Removes one of the actor’s own push endpoints.',
  },
  {
    file: 'src/modules/mobile/notifications.ts',
    symbol: 'setPreference',
    category: 'self',
    why: 'Writes a preference row keyed on the actor’s own user id; a topic is checked, not a role.',
  },
  {
    file: 'src/modules/notify/email-change.ts',
    symbol: 'requestAddressChange',
    category: 'self',
    why:
      'Starts a confirmation to the actor’s own new address. Nothing changes until ' +
      'that address answers, so the act itself grants nothing.',
  },
  {
    file: 'src/modules/practice/switching.ts',
    symbol: 'switchCompany',
    category: 'self',
    why:
      'Changes which of the actor’s own memberships the session is looking through. ' +
      'The authority is the membership it finds, and a role inside a company cannot ' +
      'govern the choice of which company to enter.',
  },

  // --- token: no actor exists --------------------------------------------
  //
  // These take no ActorContext, which is the checkable part: there is no
  // principal to hold a permission, so a gate is not merely unnecessary but
  // unwritable. What stands in its place is a single-use token, and each of the
  // three looks its token up before anything else happens.
  {
    file: 'src/modules/crm/acceptance.ts',
    symbol: 'acceptProposal',
    category: 'token',
    why:
      'The client signing a proposal is not a member of the company and never will ' +
      'be. The proposal’s public token is the whole of their authority (ADR 0021).',
  },
  {
    file: 'src/modules/notify/invitations.ts',
    symbol: 'acceptInvitation',
    category: 'token',
    why:
      'The act that creates the membership cannot require one. The invitation token ' +
      'is what says this person was asked.',
  },
  {
    file: 'src/modules/notify/password-reset.ts',
    symbol: 'completePasswordReset',
    category: 'token',
    why:
      'Reached by somebody who by definition cannot sign in. The reset token is the ' +
      'credential, and it is spent on use.',
  },

  // --- bootstrap: no company exists yet ----------------------------------
  {
    file: 'src/modules/tenancy/onboarding.ts',
    symbol: 'registerCompany',
    category: 'bootstrap',
    why:
      'Writes the company and the first membership in one transaction — the two ' +
      'audit events this function files. A permission is held *in* a company, so ' +
      'there is nothing to hold until this returns. It is the one act in the system ' +
      'that cannot be gated for a reason of arithmetic rather than of policy.',
  },

  // --- practice: a different authority model -----------------------------
  //
  // The nomination had no category for this and it is the most interesting of
  // the nine. A practice is not a company: an accountant's firm is authorised by
  // its own ownership of the engagement, through `requirePracticeOwner`, which is
  // used eight times and is not a `Permission` at all. `blindProducers` iterates
  // `ROLE_NAMES` and so cannot speak about these acts in either direction — a
  // limit worth naming rather than a hole worth hiding.
  {
    file: 'src/modules/practice/service.ts',
    symbol: 'removePracticeMember',
    category: 'practice',
    gatedBy: 'requirePracticeOwner',
    why: 'Only a practice’s own owner may remove one of its members.',
  },
  // `endEngagement` was the second entry here and the register threw it out,
  // which is the register working. It gates **both** ways: `company:manage` if
  // the party is the client, `requirePracticeOwner` if it is the practice — a
  // tenth form, an either/or across two authority models, chosen by which side
  // of the engagement is speaking. The scan reads the literal branch, so the act
  // is no longer open and belongs to no category here. It is worth recording
  // that the branch the scan *cannot* read is the practice one, so what
  // `blindProducers` now says about this act covers the client side only.

  // --- delegated: the refusal is one call away ----------------------------
  //
  // The two acts where a scan would have to follow a call to find the gate, and
  // where following it is sound because the refusal is *blocking*:
  // `transactionContext` returns `null` without `bookkeeping:view` and both
  // callers then return `{ ok: false }`. That is the distinction a transitive
  // scan cannot make and a declaration can.
  {
    file: 'src/modules/ai/bookkeeping.ts',
    symbol: 'suggestCategory',
    category: 'delegated',
    gatedBy: 'transactionContext',
    why:
      'Gated twice over, both one call down: `transactionContext` refuses a reader ' +
      'without `bookkeeping:view` by returning nothing, and `ask` requires `ai:use`. ' +
      'The assistant is another way to arrive at a decision, never another way to ' +
      'make one, so it inherits the permission of the thing it reads.',
  },
  {
    file: 'src/modules/ai/bookkeeping.ts',
    symbol: 'suggestRule',
    category: 'delegated',
    gatedBy: 'transactionContext',
    why: 'The same two gates, for the rule the same transaction suggests.',
  },

  // --- internal: not reachable from src/app -------------------------------
  //
  // Each of these is called only from an act that is itself gated, and the
  // checkable consequence is that `src/app` cannot import it. Five are module
  // private, which is the stronger form of the same statement; the rest are
  // exported for a sibling module or a test. Gating them again would be the
  // "two answers to one question" defect: a second check that can disagree with
  // the first.
  {
    file: 'src/modules/assets/service.ts',
    symbol: 'postPeriod',
    category: 'internal',
    why: 'Module private. One period of a depreciation run, from `runDepreciation` under `accounting:journal`.',
  },
  {
    file: 'src/modules/banking/revision-service.ts',
    symbol: 'recordRevisions',
    category: 'internal',
    why: 'Records what a bank changed after the fact, during `importTransactions`.',
  },
  {
    file: 'src/modules/banking/revision-service.ts',
    symbol: 'recordRetractions',
    category: 'internal',
    why: 'The other half of the same sweep — transactions the bank withdrew.',
  },
  {
    file: 'src/modules/banking/sync.ts',
    symbol: 'importTransactions',
    category: 'internal',
    why:
      'Reached from `syncConnection` under `bookkeeping:import`. The nomination ' +
      'guessed this family was "run from a worker"; there is no worker, only a ' +
      'gated act that does a lot.',
  },
  {
    file: 'src/modules/bookkeeping/rules-engine.ts',
    symbol: 'applyRulesToNewTransactions',
    category: 'internal',
    why: 'Runs the company’s own rules over rows `importTransactions` has just brought in.',
  },
  {
    file: 'src/modules/parties/service.ts',
    symbol: 'unlink',
    category: 'internal',
    why:
      'Module private. Called by `setVendorOrganization`, which requires ' +
      '`accounting:journal` and `crm:view` — the conjunction that produced Phase ' +
      '213’s one false finding.',
  },
  {
    file: 'src/modules/payables/pay-runs.ts',
    symbol: 'closePayRun',
    category: 'internal',
    why: 'Closes the run `executePayRun` has just paid, under `accounting:journal`.',
  },
  {
    file: 'src/modules/payments/service.ts',
    symbol: 'postCapturedCheckout',
    category: 'internal',
    why:
      'Posts a captured checkout through `recordPayment` under `accounting:journal`. ' +
      'Reached from `settleCheckout`, never from a route.',
  },
  {
    file: 'src/modules/receivables/credits.ts',
    symbol: 'applyCreditWithin',
    category: 'internal',
    why:
      'Module private, and the `Within` suffix says what it is: the body of the act ' +
      'without its transaction, so `createCreditNote` and `applyCredit` can share ' +
      'it. Both require `accounting:journal`.',
  },
  {
    file: 'src/modules/receivables/vendor-credits.ts',
    symbol: 'applyVendorCreditWithin',
    category: 'internal',
    why: 'The payables twin of the same split, with the same two gated callers.',
  },
  {
    file: 'src/modules/timebilling/billing.ts',
    symbol: 'applyRetainerWithin',
    category: 'internal',
    why: 'The third of the same shape, shared by `billWork` and `applyRetainer`.',
  },
  {
    file: 'src/modules/tenancy/onboarding.ts',
    symbol: 'addMember',
    category: 'internal',
    why:
      'Called by `registerUser` while a membership is being created, which is the ' +
      'bootstrap case one level down.',
  },
  {
    file: 'src/modules/evidence/service.ts',
    symbol: 'storeDocument',
    category: 'internal',
    why:
      'The primitive that puts bytes in the object store and a `documents` row over ' +
      'them. It cannot gate, because it is not told what the document is *for* — ' +
      'the subject’s permission belongs to the attach. Phase 214 moved it behind ' +
      '`attachNewDocument` for exactly that reason: it was reachable from a server ' +
      'action, and the only check on the path ran after the bytes were written.',
  },
]

const KEY = (file: string, symbol: string) => `${file}::${symbol}`

/** The declared reason an act needs no permission, or a refusal naming it. */
export function openAct(file: string, symbol: string): OpenAct {
  const found = OPEN_ACTS.find((act) => act.file === file && act.symbol === symbol)
  if (found) return found

  throw new RegistryError({
    registry: 'OPEN_ACTS',
    key: KEY(file, symbol),
    message:
      `\`${symbol}\` in ${file} writes an audit event behind no permission check of any ` +
      'form, and no entry says why. Phase 213 skipped every such act on one shared ' +
      'reason — that an ungated act names no producer — and that reason was wrong for ' +
      'eleven of the forty-four it covered. Either gate the act, or declare it here ' +
      'with the category that makes its openness checkable.',
  })
}

/** Where a `requirePermission`/`can` call opens its argument list. */
const CHECK = /\b(?:requirePermission|can)\(/g

export type PermissionChecks = {
  /** Checks written as a string literal, whether thrown or refused softly. */
  literal: readonly Permission[]
  /** Checks whose permission is computed, as written. */
  computed: readonly string[]
  /**
   * Checks applied to a permission the function did not choose (Phase 218).
   *
   * A bare identifier that the function binds — a parameter, or an arrow's
   * parameter — is not an expression a register can resolve, because it is not
   * an expression at all. `ifPermitted(ctx, permission, …)` checks whatever its
   * caller passed; `permissionsToRead(entityType).some((p) => can(ctx, p))`
   * checks each of a computed list whose expression is on the same line.
   *
   * Kept rather than dropped. Dropping it would make these functions read as
   * ungated, which is ADR 0134's direction; answering it is what the invented
   * `company:manage` did. A third name is the only reading that is neither.
   */
  forwarded: readonly string[]
}

/**
 * The permission argument of a check, read by balancing brackets.
 *
 * A regular expression cannot do this and the first version of this function
 * proved it: `/([^;\n]+?)\)/` on
 * `requirePermission(ctx, permissionFor(document.kind, 'manage'))` stops at the
 * *inner* bracket and hands back `permissionFor(document.kind, 'manage'` — an
 * expression that appears in no source file, so the resolver refused a key
 * nobody could add. Which is the phase's own lesson arriving one layer down: a
 * computed permission is exactly the thing a pattern cannot read.
 */
export function callArguments(body: string, open: number): string[] {
  const commas: number[] = []
  let depth = 0

  for (let at = open; at < body.length; at += 1) {
    const char = body[at]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) {
        const cuts = [open, ...commas, at]
        return cuts
          .slice(0, -1)
          .map((from, index) => body.slice(from + 1, cuts[index + 1]).trim().replace(/\s+/g, ' '))
      }
    } else if (char === ',' && depth === 1) commas.push(at)
  }

  return []
}

function secondArgument(body: string, open: number): string | null {
  return callArguments(body, open)[1] ?? null
}

export function permissionChecksIn(
  body: string,
  bound: Iterable<string> = [],
): PermissionChecks {
  const literal: Permission[] = []
  const computed: string[] = []
  const forwarded: string[] = []

  const names = new Set(bound)
  // An arrow's own parameter is bound inside the body rather than in the
  // signature: `permissionsToRead(entityType).some((permission) => …)`.
  for (const arrow of body.matchAll(/\(\s*(\w+)\s*\)\s*=>/g)) names.add(arrow[1])

  for (const match of body.matchAll(CHECK)) {
    const argument = secondArgument(body, match.index + match[0].length - 1)
    if (argument === null) continue
    if (/^'[a-z_]+:[a-z_]+'$/.test(argument)) literal.push(argument.slice(1, -1) as Permission)
    else if (/^\w+$/.test(argument) && names.has(argument)) forwarded.push(argument)
    else computed.push(argument)
  }

  return { literal, computed, forwarded }
}

/**
 * The `{` that opens a declaration's body: past the parameter list, not into it.
 *
 * Cutting at the first `{` after the name would land inside a parameter whose
 * type is an object literal (`input: { openDocuments: number }`), which is the
 * same half-read signature the Phase 218 fix is removing. So the parameter list
 * is balanced first.
 */
function bodyBrace(blanked: string, at: number): number | null {
  const open = blanked.indexOf('(', at)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < blanked.length; i += 1) {
    if (blanked[i] === '(') depth += 1
    else if (blanked[i] === ')') {
      depth -= 1
      if (depth === 0) {
        const brace = blanked.indexOf('{', i)
        return brace < 0 ? null : brace
      }
    }
  }
  return null
}

/**
 * The body of a top-level function, comments blanked.
 *
 * ## The two readings that disagreed (Phase 218)
 *
 * This used to find the declaration with `function\s+${symbol}\b` and then hand
 * the offset to `enclosingSpan`, which reads a declaration as
 * `function <name>(` — so the two disagreed about every **generic** function:
 * the first found `function scoped<T …>(`, the second could not see it,
 * attributed the offset to the previous declaration and ran the span on to the
 * next one it recognised. Asked for `scoped` it returned `can`'s body, from
 * `can` to the end of `context.ts`, and nothing marked the answer as wrong.
 *
 * Both now go through `declarationOffset`, which is `DECLARATION` asked about
 * one name, so there is one reading of where a function begins.
 *
 * The span is also cut at the body's opening brace rather than at the
 * declaration, because the **signature** is not part of the body and reading it
 * as one made the permission checker's own parameter list look like a gate:
 * `requirePermission(ctx: ActorContext, permission: Permission)` answered
 * `permissionChecksIn` with the computed check `permission: Permission`, which
 * `gatesIn` could not resolve and so replaced with an invented
 * `company:manage`. Four functions, all of them in `tenancy/context.ts` — the
 * checker reading its own declaration as a check.
 */
export function functionBody(file: string, symbol: string): string | null {
  const key = `${file}::${symbol}`
  if (bodies.has(key)) return bodies.get(key) ?? null

  const { raw, blanked } = sourceOf(file)
  const at = declarationOffset(raw, symbol)
  const body =
    at === null
      ? null
      : (() => {
          const span = enclosingSpan(raw, at)
          const brace = bodyBrace(blanked, at)
          return blanked.slice(brace === null || brace >= span.to ? span.from : brace, span.to)
        })()

  bodies.set(key, body)
  return body
}

/**
 * Bodies already cut, by file and symbol.
 *
 * Separate from `sourceOf` because the walk asks the *same* pair repeatedly: a
 * helper reached from forty acts is cut forty times, each cut running
 * `declarationOffset` and `enclosingSpan` over the file again. A `null` is cached
 * too — "no such function here" is an answer worth not recomputing, and it is the
 * common one, since the walk asks every file it imports from about every name it
 * sees called.
 */
const bodies = new Map<string, string | null>()

/**
 * One file's text and its comment-blanked twin, read once per process.
 *
 * ## Why this exists
 *
 * The scans read the same files over and over. `mayDemand` and `willDemand` walk
 * 329 acts to depth four, and every step asks `functionBody`, which read the
 * file from disk and ran `withoutComments` across all of it — a regex pass over
 * the whole source — to answer about one symbol. For a several-thousand-line
 * module reached by many acts, that is the same pass repeated for each of them.
 *
 * The measurement that forced it (Phase 220): the comparison of `willDemand`
 * against `mayDemand` over all 329 acts took **32s against a 30s limit**. It
 * passed in Phase 219's run on source identical to today's, so nothing had
 * regressed — the test had always been close to the line, and the line is not
 * where the cost belongs. Caching the reads makes it cheaper rather than
 * permitted, which is the difference between fixing it and hiding it.
 *
 * Sound because a scan describes the tree as it is on disk when the process
 * starts, and nothing here writes a source file and re-scans it in the same run:
 * the falsifiers hand their source in as a string, for this reason among others.
 *
 * It lives in this module rather than in `enclosing.ts` because that one has no
 * imports at all. Its whole argument for existing is that it is text work shared
 * by scans that each define a table, a column and a gate their own way, and
 * giving it a file cache would be the first thing it knows about the world.
 */
const sources = new Map<string, { raw: string; blanked: string }>()

export function sourceOf(file: string): { raw: string; blanked: string } {
  const cached = sources.get(file)
  if (cached) return cached

  const raw = readFileSync(file, 'utf8')
  const entry = { raw, blanked: withoutComments(raw) }
  sources.set(file, entry)
  return entry
}

/** Every name `src/app` imports, which is every module act a route can reach. */
export function namesImportedByApp(): Set<string> {
  const names = new Set<string>()

  for (const file of sourceFiles('src/app')) {
    const src = withoutComments(readFileSync(file, 'utf8'))
    for (const match of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim()
        if (name) names.add(name)
      }
    }
  }

  return names
}

/**
 * Entries whose stated reason the source does not bear out.
 *
 * One checkable consequence per category — this is the whole difference between
 * a register and a comment. A `self` act must constrain by the actor's own user
 * id; a `token` act must have no actor to gate; an `internal` act must be
 * unreachable from `src/app`; a `delegated` or `practice` act must name a
 * gatekeeper that exists and really refuses.
 */
export function miscategorisedActs(imported = namesImportedByApp()): string[] {
  const wrong: string[] = []

  for (const act of OPEN_ACTS) {
    const body = functionBody(act.file, act.symbol)
    if (body === null) {
      wrong.push(`${KEY(act.file, act.symbol)}: no such function`)
      continue
    }

    const head = body.slice(0, Math.max(0, body.indexOf('{')) || 400)

    switch (act.category) {
      case 'self':
        if (!/\b(?:ctx|actor)\.userId\b/.test(body)) {
          wrong.push(`${KEY(act.file, act.symbol)}: declared self, never names the actor's own user id`)
        }
        break

      case 'token':
      case 'bootstrap':
        if (/:\s*ActorContext/.test(head)) {
          wrong.push(`${KEY(act.file, act.symbol)}: declared ${act.category}, but takes an ActorContext`)
        }
        break

      case 'internal':
        if (imported.has(act.symbol)) {
          wrong.push(`${KEY(act.file, act.symbol)}: declared internal, but src/app imports it`)
        }
        break

      case 'delegated':
      case 'practice': {
        if (!act.gatedBy) {
          wrong.push(`${KEY(act.file, act.symbol)}: declared ${act.category} and names no gatekeeper`)
          break
        }
        if (!new RegExp(`\\b${act.gatedBy}\\s*\\(`).test(body)) {
          wrong.push(`${KEY(act.file, act.symbol)}: does not call ${act.gatedBy}`)
        }
        break
      }
    }
  }

  return wrong
}

/** Entries that no longer describe an act with no permission check. */
export function staleOpenActs(): string[] {
  const stale: string[] = []

  for (const act of OPEN_ACTS) {
    const body = functionBody(act.file, act.symbol)
    if (body === null) {
      stale.push(`${KEY(act.file, act.symbol)}: no such function`)
      continue
    }

    const checks = permissionChecksIn(body)
    if (checks.literal.length > 0 || checks.computed.length > 0) {
      stale.push(
        `${KEY(act.file, act.symbol)}: now checks ` +
          [...checks.literal, ...checks.computed].join(', ') +
          ' — delete the entry',
      )
    }
  }

  return stale
}
