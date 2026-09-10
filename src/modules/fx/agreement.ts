/**
 * When one function is declared in two registries (Phase 135).
 *
 * ## The defect that started this
 *
 * Phase 134 made `importPayouts` convert. It updated that site's entry in
 * `LEDGER_POSTINGS` — `domestic` became `converted` — and left its entry in
 * `BANK_POSTINGS` saying:
 *
 * > "this is the path closest to being able to convert — **and it still does
 * > not**, because nothing compares the payout's currency to the account's."
 *
 * Both entries describe the same function. One says it converts; the other's
 * argument says it does not. Nothing noticed, because the only assertion on
 * that prose was `because.length > 140`, and a false sentence is exactly as
 * long as a true one.
 *
 * ## What is actually checkable
 *
 * Measured: **fourteen symbols are declared in two registries**, every one of
 * them in `BANK_POSTINGS` and `LEDGER_POSTINGS` together. The two answer
 * different questions and must not be required to match:
 *
 * - `basis` — is the **figure** the company's own money?
 * - `handling` — can the path cope with the **account** being foreign?
 *
 * A path can post a converted figure and still refuse a foreign account, and
 * six of the fourteen do. But the implication in the other direction is real:
 *
 * > **`converts` ⟹ `converted`.** A path that converts *for the account* is by
 * > definition producing a figure in the company's own money. There is no way
 * > to be one and not the other.
 *
 * All four `converts` sites satisfy it today. Declaring it means a future
 * `converts` + `domestic` pair fails here rather than being two answers to one
 * question that nobody put side by side.
 *
 * The equivalence is **not** claimed, and the test says so, because six
 * `refuses` + `converted` rows are correct and somebody tidying this up would
 * otherwise "fix" them.
 *
 * ## And what the prose may not do
 *
 * The rest is Phase 134's actual defect: prose in one registry denying what the
 * other registry declares. That cannot be checked in general — most of a
 * `because` is an argument, not a claim a machine can evaluate. What *can* be
 * checked is a small set of phrases that deny a thing a sibling asserts, which
 * is why `DENIALS` is a registry with prose of its own rather than a regex
 * buried in a test.
 */

/**
 * ## The overlap is wider than the symbols
 *
 * ADR 0135 first claimed that nothing else in the repository declares the same
 * key twice. **That was false**, and it is the same class of error this phase
 * exists to catch, committed in the phase's own document. Measured: fifteen
 * table names appear in more than one registry, and `invoices` is in four —
 * `CURRENCY_CARRIERS`, `FACE_COLUMNS`, `INHERITED_CURRENCY`, `PAIRED_COLUMNS`.
 *
 * They are not redundant. Each answers its own question about the table, so
 * again there is no equality to enforce — but one implication is real:
 *
 * > **A table with a functional twin must get its currency from somewhere.**
 * > `PAIRED_COLUMNS` says a face amount has a counterpart in the company's
 * > money. That conversion needs a currency to convert *from*, which is either
 * > the table's own column (`CURRENCY_CARRIERS`) or one it reaches through a
 * > mandatory foreign key (`INHERITED_CURRENCY`).
 *
 * All ten paired tables satisfy it. A future pair on a table with no currency
 * anywhere would be a functional figure converted from nothing.
 */

/** What one registry says, put beside what the other says about the same symbol. */
export type CrossDeclaration = {
  symbol: string
  /** From `LEDGER_POSTINGS`. Absent when the symbol is not declared there. */
  basis?: string
  /** From `BANK_POSTINGS`. Absent when the symbol is not declared there. */
  handling?: string
  /** The argument each side gives. */
  ledgerBecause?: string
  bankBecause?: string
}

export type Agreement = { ok: true } | { ok: false; why: string }

/**
 * A phrase that denies conversion, and what makes it a denial rather than
 * ordinary prose.
 *
 * The registry-with-prose device (Phase 101). A bare list of regexes is a fact
 * that looks the same whether it is right or wrong, and this one is doing
 * something delicate: deciding that a sentence written by a person means the
 * opposite of what a sibling declaration asserts. Each entry has to say why it
 * is safe to read that way.
 *
 * Deliberately small. A phrase that fires on prose which is merely *describing*
 * the old behaviour would make this check unusable, and an unusable check gets
 * deleted rather than fixed.
 */
export type Denial = {
  name: string
  matches: RegExp
  because: string
}

export const DENIALS: readonly Denial[] = [
  {
    name: 'still does not',
    matches: /\bit still does not\b/i,
    because:
      'The exact shape of Phase 134’s defect. "Still" is a claim about the present made in ' +
      'contrast with an expectation — it cannot be read as describing history, because history ' +
      'would be "did not". A sentence saying a path still does not convert, beside a declaration ' +
      'that it converts, is two answers to one question.',
  },
  {
    name: 'does not convert',
    matches: /\bdoes not (?:yet )?convert\b/i,
    because:
      'The plain present-tense denial. Excluded from matching "did not convert" and "would not ' +
      'convert" on purpose: the first is history, which a `because` is often right to recount, ' +
      'and the second is a hypothetical about a path not taken.',
  },
  {
    name: 'posts the face amount',
    matches: /\bposts the face (?:amount|figure)\b/i,
    because:
      'What a site declared `converted` cannot be doing. Phase 127 built `LEDGER_POSTINGS` to ' +
      'find exactly this, so a `because` claiming it while the basis says otherwise is the ' +
      'registry contradicting the thing it exists to declare.',
  },
]

/**
 * Prose with its quotations removed.
 *
 * Found by this check on its first use, against the entry written to fix what
 * it had just caught: the corrected `importPayouts` prose *quotes* the sentence
 * it is correcting, and the denial fired on the quotation.
 *
 * That is not a nuisance to route around. Registries in this project recount
 * their own history constantly — "**Corrected in Phase 128**", "this said X,
 * which is false" — and a check that cannot tell a quotation from a claim makes
 * the honest entry the one that fails. Quoted text is somebody else's sentence
 * being reported, not this entry asserting it.
 *
 * Both quote marks this codebase uses, and the straight double quote as well,
 * since prose is written in all three.
 */
export function withoutQuotations(prose: string): string {
  return prose.replace(/[“"'‘]([^”"'’]*)[”"'’]/g, ' ')
}

/**
 * Whether a sentence denies that conversion happens.
 *
 * Reads past quotations, so an entry may say what it used to say wrongly.
 */
export function deniesConversion(prose: string): Denial | null {
  const claimed = withoutQuotations(prose)
  return DENIALS.find((denial) => denial.matches.test(claimed)) ?? null
}

/**
 * Whether two registries describing one symbol can both be true.
 *
 * Returns the sentence a person needs, not a boolean: the whole point is that
 * somebody changed one declaration and not the other, and the fix is to know
 * which two disagree and about what.
 */
export function agreementFor(input: CrossDeclaration): Agreement {
  const { symbol, basis, handling } = input

  // `converts` ⟹ `converted`. See the note above on why the converse is not
  // checked: six correct rows are `refuses` + `converted`.
  if (handling === 'converts' && basis !== undefined && basis !== 'converted') {
    return {
      ok: false,
      why:
        `BANK_POSTINGS says ${symbol} converts for a foreign account, and LEDGER_POSTINGS says ` +
        `its figure is \`${basis}\`. A path that converts for the account is producing a figure ` +
        'in the company’s own money by definition, so one of the two is wrong.',
    }
  }

  // Prose in one registry denying what the other declares.
  if (basis === 'converted') {
    for (const [side, prose] of [
      ['BANK_POSTINGS', input.bankBecause],
      ['LEDGER_POSTINGS', input.ledgerBecause],
    ] as const) {
      if (!prose) continue
      const denial = deniesConversion(prose)
      if (denial) {
        return {
          ok: false,
          why:
            `LEDGER_POSTINGS declares ${symbol} \`converted\`, and its ${side} entry argues the ` +
            `opposite — "${denial.name}". A declaration and the prose beside it are two answers ` +
            'to one question, and the prose is the one nothing was checking.',
        }
      }
    }
  }

  return { ok: true }
}

/**
 * Whether a table's declarations across the currency registries can all hold.
 *
 * `carriers` and `inheritors` are the table names each registry declares,
 * passed in rather than imported, so this file stays a core with no dependency
 * on the three registries it reasons about.
 */
export function tableAgreementFor(input: {
  table: string
  paired: boolean
  carriers: ReadonlySet<string>
  inheritors: ReadonlySet<string>
}): Agreement {
  const { table, paired, carriers, inheritors } = input

  if (paired && !carriers.has(table) && !inheritors.has(table)) {
    return {
      ok: false,
      why:
        `PAIRED_COLUMNS gives ${table} a functional twin, and neither CURRENCY_CARRIERS nor ` +
        'INHERITED_CURRENCY says where its currency comes from. A functional figure is a face ' +
        'figure converted from some currency, so a pair on a table that has none is converted ' +
        'from nothing.',
    }
  }

  return { ok: true }
}
