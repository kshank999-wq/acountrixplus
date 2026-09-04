/**
 * Who a thrown message was written for (Phase 119).
 *
 * ## The defect
 *
 * ADR 0074 settled how errors reach a screen: `DomainError` is shown, and
 * **everything else is logged and replaced with the caller's fallback**, so a
 * driver error can never publish table names or echo somebody's email back at
 * them. Deny by default, and right.
 *
 * What was never finished is the other half. Forty-three of the forty-four
 * server actions call `messageFor`, and the module layer under them throws
 * `new Error(...)` **298 times**. Measured across `src/modules`, with the
 * containing function's name searched for anywhere in `src/app`:
 *
 * ```
 * exported functions throwing a person-facing plain Error   103
 *   ...of those, reachable from src/app                      80
 *   sentences in those functions that never reach a person  144
 * ```
 *
 * Sentences like *"That is a vendor credit. It cannot be applied to an
 * invoice."*, *"That change order was rejected. Raise a new one instead."*,
 * *"A cost code needs the job it belongs to. Choose a job as well."* — each
 * written by somebody who knew exactly what the reader needed to do next, each
 * arriving on screen as **"Something went wrong."**
 *
 * Phase 118 hit this live: `ChartError extends Error` made all four of that
 * phase's refusals unreadable, and thirty-three passing tests could not see it,
 * because a test calls the service directly and asserts on the thrown message.
 * The test suite is exactly the wrong instrument for this defect.
 *
 * ## Why a classifier rather than a rule about types
 *
 * "No bare `throw new Error` in `src/modules`" would be simple and wrong. Some
 * of those 298 are for an operator and must stay hidden: a missing
 * `ENCRYPTION_KEY`, an unregistered provider key, an invariant that means the
 * code is broken rather than the input. Hiding those is the point of ADR 0074.
 *
 * So the question is not *what type was thrown* but **who the sentence was
 * written for**, and that is decidable from the sentence itself. A message
 * written for a person is a sentence: it starts with a capital, ends in a full
 * stop or a question mark, and addresses the reader. A message written for an
 * operator is a fragment naming a thing — `Customer not found`, `Unknown bank
 * provider "x"` — with no capital-to-full-stop shape, because nobody writes
 * prose for a log line.
 *
 * This is a heuristic, and it is stated as one. Its job is to be the tripwire's
 * rule, so `tests/refusal-audience.test.ts` can fail the moment somebody writes
 * a new refusal that will never be read.
 *
 * ## What Phase 119 did with it
 *
 * 192 sites across 46 files became `throw new Refusal(...)`. Fourteen stayed
 * bare and are listed in `ALLOWED_BARE_REFUSALS` below, each with the argument
 * for it. The heuristic got those fourteen wrong — they read as prose because
 * somebody was explaining something, but the explanation is for whoever
 * maintains this, and two of them name environment variables.
 */

export type Audience =
  /** Written for whoever hit it, and useless in a log. */
  | 'person'
  /** Written for whoever maintains this, and unsafe or meaningless on a screen. */
  | 'operator'

/**
 * What makes a thrown message a sentence somebody was meant to read.
 *
 * Each rule carries the argument for itself, on the Phase 101 device — a bare
 * list of regular expressions is a fact that looks the same whether it is right
 * or wrong.
 */
export type AudienceRule = {
  name: string
  because: string
  /** True when this rule says the message was written for a person. */
  holds: (message: string) => boolean
}

export const AUDIENCE_RULES: readonly AudienceRule[] = [
  {
    name: 'opens like a sentence',
    because:
      'Prose for a reader starts with a capital. A log fragment names a thing and starts ' +
      'wherever the identifier does, so this separates "That invoice is voided." from ' +
      '"invoices.balance_cents out of range".',
    holds: (message) => /^[A-Z“"']/.test(message.trim()),
  },
  {
    name: 'closes like a sentence',
    because:
      'A full stop or a question mark is the mark of something written to be read out. ' +
      'Nobody punctuates a log line, so its absence is the strongest single signal that a ' +
      'message was never meant for a screen.',
    holds: (message) => /[.?”"']$/.test(message.trim()),
  },
  {
    name: 'says more than a name',
    because:
      'A message of one or two words is a label, not an explanation — "Not found" tells a ' +
      'person nothing they did not already know. Three words is the floor for a sentence ' +
      'that says what is wrong and what would fix it.',
    holds: (message) => message.trim().split(/\s+/).length >= 3,
  },
]

/**
 * Who this message was written for.
 *
 * Every rule must hold for a message to count as person-facing: the rules are
 * *evidence that somebody wrote prose*, and any one of them alone is too easy
 * to satisfy by accident.
 */
export function audienceOf(message: string): Audience {
  return AUDIENCE_RULES.every((rule) => rule.holds(message)) ? 'person' : 'operator'
}

/**
 * Bare `throw new Error` sites that read as a sentence and stay bare anyway.
 *
 * The rules above are a heuristic, and these fourteen are where it is wrong:
 * each one is written in prose because whoever wrote it was explaining
 * something, but the explanation is for whoever maintains this, not whoever
 * clicked. Showing them would be the leak ADR 0074 exists to prevent — two of
 * them name environment variables.
 *
 * Each entry argues for itself rather than merely being listed, on the Phase
 * 101 device, and `tests/refusal-audience.test.ts` fails if one of these sites
 * stops existing or if a new bare person-facing throw appears without an entry
 * here. That is the point: a future exception has somewhere to make its case in
 * prose, instead of being smuggled in by weakening the rules.
 */
export const ALLOWED_BARE_REFUSALS: readonly {
  file: string
  message: string
  because: string
}[] = [
  {
    file: 'src/modules/fx/addition.ts',
    message:
      'No addition form is declared for "X". A tripwire that scans for sums has to say which '
      + 'forms of sum it scans for, or its guarantee is narrower than it reads.',
    because:
      'The sixth registry lookup to trip this rule, after prompts, retention policies, record ' +
      'kinds and falsifiers. It reads as prose because it is explaining a rule to whoever is ' +
      'adding a third way of summing money — and that person is a maintainer holding a failing ' +
      'test, not somebody who clicked something. A key nobody declared cannot reach a screen: ' +
      'the keys are literals in this repository.',
  },
  {
    file: 'src/modules/fx/on-screen.ts',
    message:
      'No basis is declared for X in X. Money reaching a screen has to say whether it came off '
      + 'a document — which carries its own currency — or out of the books, which are in the '
      + 'company’s. Nothing else can tell the two apart at the call site.',
    because:
      'The same shape as its sibling above, and the seventh overall. It fires when a prop type ' +
      'carrying money has not been classified, which only ever happens while somebody is running ' +
      'the scan that found it. Phase 125 is the reason to keep it a throw rather than a return: ' +
      'the classification it demands is exactly what that phase found two phases had got wrong.',
  },
  {
    file: 'src/modules/fx/ledger.ts',
    message:
      'No ledger posting basis is declared for X in X. Money reaching debitCents or creditCents '
      + 'is the company’s own money — say why this is, in src/modules/fx/ledger.ts, or convert it '
      + 'first.',
    because:
      'The eighth, and the same shape as the two above: a registry lookup that refuses rather ' +
      'than returning undefined, firing only for somebody running the scan it belongs to. Eight ' +
      'instances of one pattern is now the argument for a RegistryError subclass rather than an ' +
      'allowlist entry per registry — recorded here as a nomination, because inventing it in the ' +
      'same commit as the phase that needed it would be a change nobody measured.',
  },
  {
    file: 'src/modules/ai/prompts.ts',
    message: 'No prompt registered for "X"',
    because:
      'A prompt key that is not in the registry means code asked for a prompt nobody wrote. ' +
      'No user action produces it and no user action would fix it.',
  },
  {
    file: 'src/modules/auth/secret-box.ts',
    message: 'Stored secret is not in a form this version can read.',
    because:
      'A stored secret in an unreadable envelope is a deployment or key-rotation problem. ' +
      'Telling the person at the keyboard about the envelope format helps nobody and says ' +
      'more about the crypto than it should.',
  },
  {
    file: 'src/modules/evidence/store.ts',
    message:
      'OBJECT_STORE=filesystem needs OBJECT_STORE_PATH set to a directory the application ' +
      'may write to.',
    because:
      'Names OBJECT_STORE_PATH. An environment variable is exactly the kind of thing ADR ' +
      '0074 exists to keep off a screen.',
  },
  {
    file: 'src/modules/notify/providers/http.ts',
    message:
      'TRANSACTIONAL_EMAIL_PROVIDER is "X" but X is not set. Set it, or use ' +
      'TRANSACTIONAL_EMAIL_PROVIDER=mock to keep mail in memory.',
    because:
      'Names TRANSACTIONAL_EMAIL_PROVIDER and the missing key beside it, for the same ' +
      'reason: configuration belongs in a log, not in front of somebody sending a letter.',
  },
  {
    file: 'src/modules/notify/providers/index.ts',
    message: 'Unknown transactional email provider "X". Available: mock, X.',
    because:
      'Lists the registered provider names. Configuration again, and a person sending a ' +
      'letter can do nothing whatever with it.',
  },
  {
    file: 'src/modules/worker/runner.ts',
    message:
      'Job "X" needs a company and has none. Enqueue it with a companyId, or register the ' +
      'handler as global.',
    because:
      'A handler enqueued without a company is a registration mistake in this codebase. The ' +
      'sentence is addressed to whoever registered the handler, and says so.',
  },
  {
    file: 'src/modules/ledger/as-at.ts',
    message: 'Nothing declares how a X settles a document.',
    because:
      'The Phase 101 registry throw: a settlement kind exists that nothing declared. It is ' +
      'the "make a new table answer the question" device speaking to the developer adding ' +
      'the kind, not to anybody who clicked something.',
  },
  {
    file: 'src/modules/ledger/control-account.ts',
    message: 'Nothing declares how a X moves X.',
    because:
      'The same registry device, for what moves a control account. A person cannot declare ' +
      'a source type; only a developer editing the registry can.',
  },
  {
    file: 'src/modules/integrity/falsifiable.ts',
    message:
      'No falsifier is declared for the check "X". A check has to say what would make it ' +
      'disagree before it is worth running, or it is a green light with nothing behind it.',
    because:
      'The registry device a fourth time. Addressed to whoever adds a check to the register ' +
      'without saying what would make it fail — a developer editing the register, never anybody ' +
      'looking at a page.',
  },
  {
    file: 'src/modules/errors/missing.ts',
    message:
      'No record kind is declared for "X". A lookup has to say what it was looking for before ' +
      'it can tell somebody it failed.',
    because:
      'The registry device a third time, and this one caught itself: Phase 120 committed ' +
      'missing.ts and the full suite failed on this very rule, because the sentence reads as ' +
      'prose. It is addressed to whoever adds a record type without declaring its noun.',
  },
  {
    file: 'src/modules/jobs/billing.ts',
    message: 'Contract item disappeared while billing.',
    because:
      'An invariant inside a transaction that has already loaded the item. If it ever ' +
      'fires, the code is wrong rather than the application, and no wording would help.',
  },
  {
    file: 'src/modules/mobile/audience.ts',
    message: 'A notification preference names one owner, not two.',
    because:
      'Its own doc comment says it: "Both ids or neither is a programming error rather than ' +
      'a user one." A notification preference is constructed by this codebase.',
  },
  {
    file: 'src/modules/mobile/audience.ts',
    message: 'A notification preference names an owner.',
    because:
      'The other half of the same invariant — a row that named no owner at all would be ' +
      'read by nobody, and only a caller can have built one.',
  },
  {
    file: 'src/modules/mobile/decision.ts',
    message: 'A letter is addressed by construction; "no_subscription" is a push outcome.',
    because:
      'A letter is addressed by construction, so a mail channel cannot carry a push ' +
      'outcome. The caller built both fields; nobody typed them into anything.',
  },
  {
    file: 'src/modules/mobile/decision.ts',
    message: 'A notification log row needs a title to be readable.',
    because:
      'The title on a notification log row comes from the sending code, never from a form, ' +
      'so an empty one is this codebase failing to describe what it sent.',
  },
  {
    file: 'src/modules/mobile/decision.ts',
    message: 'A suppressed notification has no letter to point at.',
    because:
      'A suppression has no letter by construction, so a message id on one would name ' +
      'somebody else\'s letter. Refusing protects the log, and only a caller causes it.',
  },
]
