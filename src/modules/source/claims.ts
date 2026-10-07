/**
 * Numbers in prose that nothing reads (Phase 179).
 *
 * ## What the full suite found, and what it could not
 *
 * This phase's nomination was a clean full run, on the argument that three
 * separate phases had found a tree-wide tripwire red for reasons nobody had
 * seen: `refusal-audience` in 167 (red since 161), `isolation-guards` in 169
 * (red since 166), `registry-error` in 176 (red since the commit before it).
 *
 * The run earns its place. It also cannot find the defect audited alongside it,
 * because the defect is in sentences:
 *
 * | Where | Says | Is |
 * | --- | --- | --- |
 * | `rls.ts` ×2 | `postgres` owns all **181** tables | 182 |
 * | `rls.ts` ×2 | **163** policed tables | 162 |
 * | `isolation.ts` | **531** of **867** reads, **27** of **109** writes | 542 of 911, 28 of 111 |
 * | `DEPLOY.md` | **163** rows in `pg_policies` | 162 |
 * | `RUNBOOK.md` | **163** tables carry policies; expect **181** tables | 162; 182 |
 * | `references.ts` | **271** references | 274 |
 *
 * Every number a test reads was right. **Every number only prose held had
 * drifted.** That is not a coincidence and it is not carelessness — it is the
 * one mechanism this repository has for keeping a number true, applied to nine
 * of its counts and not to eleven others.
 *
 * Stage A found the same thing in one place: `docs/DEPLOY.md` claimed 38
 * migrations while the journal held 95, and it had been wrong for 57 of them in
 * the one document somebody follows while pointing a production database at
 * this repository. Its remedy was right and too narrow — *"fixing it again in a
 * year is not the remedy; the remedy is that the number is in a place something
 * reads."* One test, for one number. This is that test for the rest.
 *
 * ## Why the register holds the pattern and not the number
 *
 * An entry does not say "this file should say 182". It says *where the claim
 * is*, *how to recognise it*, and *how to measure the thing it is about* — so
 * when a migration adds a table, the test fails and the sentence is corrected
 * rather than the assertion being moved.
 *
 * The match has to be unique, and that is deliberate. A pattern finding two
 * numbers cannot say which one drifted, and a pattern finding none is a pin
 * that silently stopped pinning when somebody reworded the paragraph — Phase
 * 160's shape, in a test. Both are failures with their own sentence.
 *
 * ## What this does not pin
 *
 * The write and read counts. They are measured by source scans that live
 * inside `tests/isolation-guards.test.ts` and `tests/isolation-reads.test.ts`
 * rather than in a module, so nothing outside those files can ask for the
 * number. Declared here with no `measure` and listed by a test of their own, on
 * Phase 139's rule that a staged core needs a register and an acceptance test
 * naming what is not wired — because the alternative is a register that looks
 * complete and quietly covers nine of eleven.
 */

import { RegistryError } from '@/modules/errors/registry'

/**
 * What a claim can be measured against.
 *
 * Supplied by the caller rather than read here, because three of the six come
 * from the database and one from the migration journal — and a module that
 * opened a connection to check a sentence would be a module nothing could call
 * from a script.
 */
export type MeasuredFacts = {
  /** Base tables in `public`. */
  tables: number
  /** Distinct tables with at least one row level security policy. */
  policedTables: number
  /** Tables carrying a `company_id` column. */
  companyScopedTables: number
  /** Entries in `drizzle/meta/_journal.json`. */
  migrations: number
  /** Foreign keys from one tenant-scoped table to another. */
  references: number
  /** Of those, the ones whose key carries the tenant. */
  compositeReferences: number
}

export type PinnedClaim = {
  key: string
  /** Repository-relative path. */
  file: string
  /**
   * Must match **exactly once** and capture the number in group 1.
   *
   * Zero matches and two matches are both failures with their own sentence: the
   * first is a pin that stopped pinning, the second is a pin that cannot say
   * which number drifted.
   */
  pattern: RegExp
  /** What a reader does with this number, and what the wrong one costs them. */
  because: string
  /**
   * The fact the sentence is about, or `null` when it cannot be measured from
   * here yet — see the docstring.
   */
  measure: ((facts: MeasuredFacts) => number) | null
}

/**
 * The numbers in prose that something now reads.
 *
 * Ordered by who gets hurt: the two documents an operator follows while
 * pointing a production database at this repository come first, then the
 * module that answers a security questionnaire, then the registers.
 */
export const PINNED_CLAIMS: readonly PinnedClaim[] = [
  {
    key: 'deploy-migration-count',
    file: 'docs/DEPLOY.md',
    pattern: /wraps all (\d+) migrations/,
    because:
      'Stage A found this one saying 38 while the journal held 95 — wrong for 57 migrations, in ' +
      'the one document somebody follows while pointing a production database at this repository. ' +
      'A reader who pastes `bundle.sql` and counts 38 statements concludes the bundle is ' +
      'truncated and goes looking for the missing ones. It was pinned by a test of its own in ' +
      'Stage A and caught again one migration later; this register is that test generalised.',
    measure: (facts) => facts.migrations,
  },
  {
    key: 'runbook-table-count',
    file: 'docs/RUNBOOK-FIRST-COMPANY.md',
    pattern: /Expect `(\d+) tables present/,
    because:
      'The runbook tells a first deployment what `npm run db:setup-production` should print, and ' +
      'that script counts the tables rather than asserting a number — so the printed figure is ' +
      'always right and this sentence is what somebody compares it against. Wrong, it reads as a ' +
      'migration that did not land, on the one page where the advice is "stop and work out why".',
    measure: (facts) => facts.tables,
  },
  {
    key: 'runbook-policed-tables',
    file: 'docs/RUNBOOK-FIRST-COMPANY.md',
    pattern: /(\d+) tables carry\s+policies/,
    because:
      'Part of the paragraph that tells a first company its row level security is installed and ' +
      'not switched on, which is the honest disclosure the whole `RLS_ROLLOUT` device exists to ' +
      'make. A disclosure carrying a number that is two out invites the reader to doubt the rest ' +
      'of it, and the rest of it is the part that matters.',
    measure: (facts) => facts.policedTables,
  },
  {
    key: 'deploy-policed-tables',
    file: 'docs/DEPLOY.md',
    pattern: /— (\d+) rows in\s+`pg_policies`/,
    because:
      'This paragraph ends "if you are answering a security questionnaire from `pg_policies`, ' +
      'read this paragraph first", which makes it the single highest-stakes number in the ' +
      'documentation: somebody will copy it into an answer. It said 163 against a measured 161 — ' +
      'and then against 162, because the same run found a tenant-scoped table with no policy ' +
      'and policing it moved the figure while the sentence was being corrected.',
    measure: (facts) => facts.policedTables,
  },
  {
    key: 'spec-audit-policed-tables',
    file: 'docs/SPEC-AUDIT.md',
    pattern: /installed, forced on (\d+) tables/,
    because:
      'The §19 row of the specification audit, which is the document that answers "is tenant ' +
      'isolation done" with a *partial* and then says precisely how partial. **This claim was ' +
      'not in the first draft of this register, because the audit that produced the register ' +
      'read three operational documents and not this one** — and the verification run found it ' +
      'still saying 161 after the policed count moved to 162. A register assembled by grepping ' +
      'the documents somebody thought of is the same defect one level up, so this entry is here ' +
      'as much for the omission as for the number.',
    measure: (facts) => facts.policedTables,
  },
  {
    key: 'readme-owner-table-count',
    file: 'README.md',
    pattern: /superuser that owns all (\d+)\s+tables/,
    because:
      'The sentence the whole RLS section turns on — the policies are inert *because* the ' +
      'application connects as the owner of every table. A reader checking the claim counts the ' +
      'tables, finds a different number, and cannot tell whether the argument or the arithmetic ' +
      'is wrong.',
    measure: (facts) => facts.tables,
  },
  {
    key: 'rls-owner-table-count',
    file: 'src/modules/tenancy/rls.ts',
    pattern: /\*\*owns all (\d+) tables\*\*/,
    because:
      'The same claim in the module, and the module is what somebody reads when they are deciding ' +
      'whether to trust the second layer. Both copies drifted together, which is the argument for ' +
      'pinning both rather than making one quote the other: a sentence that cites another ' +
      'sentence is still a sentence nothing reads.',
    measure: (facts) => facts.tables,
  },
  {
    key: 'rls-bypass-owner-table-count',
    file: 'src/modules/tenancy/rls.ts',
    pattern: /owns all (\d+) tables here/,
    because:
      'Inside `RLS_BYPASSES`, on the entry for a table owner being exempt from its own policies. ' +
      'That register exists to name the ways row level security can be installed and do nothing, ' +
      'so its own numbers being wrong is the register demonstrating its subject.',
    measure: (facts) => facts.tables,
  },
  {
    key: 'rls-policed-table-count',
    file: 'src/modules/tenancy/rls.ts',
    pattern: /installed on all (\d+) policed tables/,
    because:
      'The summary sentence on `RLS_ROLLOUT`, whose stated job is that "nobody has to guess how ' +
      'far it got" (Phase 139). Guessing is exactly what a wrong number leaves them doing, and ' +
      'two tests one directory away had been asserting 161 since Phase 162.',
    measure: (facts) => facts.policedTables,
  },
  {
    key: 'rls-auditor-policy-count',
    file: 'src/modules/tenancy/rls.ts',
    pattern: /reads (\d+) of them and concludes/,
    because:
      'What an auditor listing `pg_policies` sees, which is the appearance the ' +
      '`policy-without-enable` bypass is named for. The number is the one they would read off the ' +
      'database, so it is the one place in this file where being approximately right is being ' +
      'wrong.',
    measure: (facts) => facts.policedTables,
  },
  {
    key: 'rls-bites-owner-table-count',
    file: 'tests/rls-bites.test.ts',
    pattern: /owns all (\d+) tables/,
    because:
      'A test file, deliberately. Its docstring makes the same load-bearing claim as the module ' +
      'and drifted the same way — and a suite that checks every number except the ones in its own ' +
      'prose is the gap this register was written for.',
    measure: (facts) => facts.tables,
  },
  {
    key: 'references-rollout-total',
    file: 'src/modules/tenancy/references.ts',
    pattern: /(\d+) references cannot be converted in one phase/,
    because:
      'The argument for `REFERENCE_ROLLOUT` existing at all: too many to convert at once, so the ' +
      'count is measured by a test and the stages are named. The count in the sentence *making* ' +
      'that argument was not the measured one — Phase 174 added two references and moved the ' +
      'assertion without moving the prose beside it.',
    measure: (facts) => facts.references,
  },
  {
    key: 'isolation-guard-distribution',
    file: 'src/modules/tenancy/isolation.ts',
    pattern: /(\d+) of the \d+ reads, against \d+ of the \d+ writes/,
    because:
      'Four numbers in one sentence and all four had drifted: 531 of 867 reads and 27 of 109 ' +
      'writes, against a measured 542 of 883 and 28 of 111. **Not pinned**, and the reason is ' +
      'the finding rather than an excuse: the scans that measure writes and reads live inside ' +
      '`tests/isolation-guards.test.ts` and `tests/isolation-reads.test.ts`, so nothing outside ' +
      'those files can ask for the number. Moving them into a module is a phase of its own, and ' +
      'declaring this here with no measure is Phase 139 — a register and an acceptance test that ' +
      'names what is not wired, because the alternative is a register that looks complete and ' +
      'covers eleven of twelve.',
    measure: null,
  },
]

export function pinnedClaimFor(key: string): PinnedClaim {
  const found = PINNED_CLAIMS.find((claim) => claim.key === key)
  if (found) return found

  throw new RegistryError({
    registry: 'PINNED_CLAIMS',
    key,
    message:
      `No pinned claim is declared as "${key}". This register is the list of numbers stated in ` +
      'prose that something now reads, so a lookup answering `undefined` would report a sentence ' +
      `as checked when nothing checks it. Declared: ${PINNED_CLAIMS.map((c) => c.key).join(', ')}.`,
  })
}

/**
 * The text a pattern is matched against.
 *
 * Newlines, Markdown wrapping, JSDoc `*` margins and the `' +` of a split
 * string literal all collapse to single spaces, because the claims this pins
 * are sentences and a sentence does not know where its line broke. Without it
 * every pattern would need to anticipate the wrap, and a reflowed paragraph
 * would silently stop being checked — which is the failure mode this register
 * is about.
 */
export function readableProse(source: string): string {
  return source
    // A JSDoc margin, and a Markdown or comment line break.
    .replace(/\n\s*\*\s?/g, ' ')
    // The seam of a string split across lines in a register entry.
    .replace(/'\s*\+\s*'/g, '')
    .replace(/\s+/g, ' ')
}

export type ClaimVerdict =
  | { key: string; ok: true; stated: number }
  | { key: string; ok: false; why: string }

/**
 * Checks one claim, counting a pattern that matches twice as a failure.
 *
 * Both edges are failures with their own sentence. Zero matches is a pin that
 * stopped pinning — somebody reworded the paragraph and the check went quiet
 * rather than red, which is Phase 160's shape inside a test. Two matches cannot
 * say which number drifted, and a check that cannot name the defect is a check
 * somebody will disable.
 */
export function claimStands(
  claim: PinnedClaim,
  source: string,
  facts: MeasuredFacts,
): ClaimVerdict {
  if (!claim.measure) {
    return { key: claim.key, ok: false, why: 'declared with no measure' }
  }

  const prose = readableProse(source)
  const global = new RegExp(claim.pattern.source, 'g')
  const matches = [...prose.matchAll(global)]

  if (matches.length === 0) {
    return {
      key: claim.key,
      ok: false,
      why:
        `${claim.file} no longer contains this claim. Either the sentence was reworded — in which ` +
        'case fix the pattern, because the check has gone quiet rather than red — or the claim was ' +
        'removed, in which case delete the entry.',
    }
  }

  if (matches.length > 1) {
    return {
      key: claim.key,
      ok: false,
      why:
        `${claim.file} states this claim ${matches.length} times, so a failure could not say which ` +
        'number drifted. Narrow the pattern, or say the number once.',
    }
  }

  const stated = Number(matches[0][1])
  const measured = claim.measure(facts)

  if (stated !== measured) {
    return {
      key: claim.key,
      ok: false,
      why: `${claim.file} says ${stated}; it is ${measured}.`,
    }
  }

  return { key: claim.key, ok: true, stated }
}

export function pinnedClaimArgues(claim: PinnedClaim): string[] {
  const problems: string[] = []

  if (claim.because.length < 220) {
    problems.push(
      `${claim.key} does not argue itself. The argument here is specifically **what a reader does ` +
        'with this number**, because a count nobody acts on is not worth a test and a count ' +
        'somebody copies into a security questionnaire is worth two.',
    )
  }

  if (!/\(\\d\+\)|\(\[0-9\]\+\)/.test(claim.pattern.source)) {
    problems.push(
      `${claim.key}'s pattern captures no number in group 1, so there is nothing to compare.`,
    )
  }

  return problems
}
