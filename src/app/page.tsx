import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor } from '@/lib/current-user'
import { INDUSTRY_PACKS, type IndustryModule } from '@/modules/coa/industry'

export const dynamic = 'force-dynamic'

/**
 * The public landing page.
 *
 * Signed-in visitors are sent to their books rather than shown marketing — the
 * home page is for people who do not have an account yet, and anybody who does
 * is trying to get to work.
 *
 * ## The rule this page is written under
 *
 * Every claim is a thing the application does, and the specific ones are
 * traceable to a phase. That is a constraint rather than modesty: a landing
 * page promising a feature the product lacks loses the first customer who signs
 * up, and it costs nothing to keep honest when the product genuinely has the
 * behaviour.
 *
 * It also shapes the argument. Accounting software is bought on trust, and the
 * cheapest way to earn it is to be specific about the awkward cases rather than
 * broad about the easy ones — anyone can post an invoice. So the page leads
 * with a real entry, spends its middle on what the system *refuses* to do, and
 * counts the industries out by what each one actually switches on.
 */

/** Reads the pack list once, so the counts on the page cannot drift from it. */
const PACKS = Object.values(INDUSTRY_PACKS)
const REAL_PACKS = PACKS.filter((pack) => pack.modules.length > 0)
const EXTRA_ACCOUNTS = PACKS.reduce((sum, pack) => sum + pack.accounts.length, 0)

const MODULE_LABELS: Record<IndustryModule, string> = {
  job_costing: 'Job costing',
  inventory: 'Inventory',
  projects: 'Projects',
  time_billing: 'Time and billing',
  pos_import: 'Daily takings',
  properties: 'Properties',
  funds: 'Restricted funds',
  appointments: 'Appointments',
  vehicles: 'Repair orders',
  manufacturing: 'Manufacturing',
  cash_drawer: 'Cash drawer',
}

export default async function Home() {
  const actor = await currentActor()
  if (actor) redirect('/bookkeeping')

  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <span className="whitespace-nowrap text-sm font-semibold tracking-tight">
            Accountrix Plus
          </span>
          <nav className="flex items-center gap-2">
            {/*
              Hidden on the narrowest screens, where three items wrap into a
              three-line header. Nothing is lost: both actions appear again in
              the hero, one scroll-free tap below.
            */}
            <Link className="btn hidden whitespace-nowrap text-sm sm:inline-flex" href="/login">
              Sign in
            </Link>
            {/*
              Two labels rather than one that wraps. At 320px the full phrase
              pushes the button 14px past the viewport edge and gets clipped —
              a measured failure, not a guessed one.
            */}
            <Link className="btn btn-primary whitespace-nowrap text-sm" href="/register">
              <span className="sm:hidden">Get started</span>
              <span className="hidden sm:inline">Set up your company</span>
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {/* ---------------------------------------------------------------- */}
        {/* Hero. The entry beside it is doing the arguing.                   */}
        {/* ---------------------------------------------------------------- */}
        <section className="mx-auto max-w-6xl px-6 pb-20 pt-16 sm:pt-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-action">
                Double-entry accounting
              </p>
              <h1 className="mt-4 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
                The books argue back
                <span className="text-action"> when you are wrong.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
                Most accounting software will happily record something that is not true. This one
                refuses the entry, names the reason, and records who tried. Every figure on every
                report traces back to a line somebody posted.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link className="btn btn-primary" href="/register">
                  Set up your company
                </Link>
                <Link className="btn" href="/login">
                  Sign in
                </Link>
              </div>

              <p className="mt-4 text-sm text-faint">
                Free to set up. Pick your trade and you have a chart of accounts and a working
                ledger in about a minute.
              </p>
            </div>

            <JournalDemo />
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* One ledger. The integration claim, which is the real product.     */}
        {/* ---------------------------------------------------------------- */}
        <section className="border-y border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="max-w-2xl text-2xl font-semibold tracking-tight">
              Everything posts to the same ledger, so the trial balance is the trial balance
            </h2>
            <p className="mt-3 max-w-2xl text-muted">
              Not a set of modules that report to each other at month end. Bank feeds, invoices,
              bills, payroll, stock movements, depreciation, foreign exchange and the cash drawer
              all write journal lines into one place, through one door.
            </p>

            <div className="mt-10 grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
              <Feature title="Debits equal credits, or nothing happens">
                An unbalanced entry is refused rather than saved as a draft. There is no state in
                which the ledger is out and somebody is meant to remember to fix it.
              </Feature>
              <Feature title="A closed period stays closed">
                Once a year is closed, posting into it is refused at the one function that writes to
                the ledger — not by a warning in the interface somebody can click past.
              </Feature>
              <Feature title="Cash and accrual from the same entries">
                Both bases are derived from what was posted, not kept as two sets of books, so they
                cannot disagree about a transaction that happened.
              </Feature>
              <Feature title="A document is owed in its own currency">
                A euro invoice stays a euro invoice. The rate on the day it was raised is not the
                rate on the day it was paid, and the difference is a realised gain or loss.
              </Feature>
              <Feature title="Nightly checks that can fail">
                A register of integrity checks runs on a schedule and tells somebody when two
                independently derived figures stop agreeing. It is designed to be able to fail.
              </Feature>
              <Feature title="Every line says who and when">
                Entries, approvals, voids and overrides are attributed. &ldquo;Why is this
                number&nbsp;this?&rdquo; has an answer that does not depend on anyone remembering.
              </Feature>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Refusals. The strongest section — specific, awkward, real cases.  */}
        {/* ---------------------------------------------------------------- */}
        <section className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="max-w-2xl text-2xl font-semibold tracking-tight">
            The kind of thing it refuses to get wrong
          </h2>
          <p className="mt-3 max-w-2xl text-muted">
            Most of the work in an accounting system is in the cases nobody demos. These are the
            ones that quietly misstate a small business&rsquo;s books for a year.
          </p>

          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <Claim wrong="$940 of sales" right="$1,000 of sales, $60 of fees">
              A card processor that deposits $940 on $1,000 of takings did not reduce your revenue.
              The fee is a cost you paid, and recording it net understates both.
            </Claim>
            <Claim wrong="Revenue when booked" right="Revenue when delivered">
              A booking is a promise, not a sale. Nothing reaches the profit and loss until the
              appointment happens, so next month&rsquo;s diary is not this month&rsquo;s income.
            </Claim>
            <Claim wrong="Tips as takings" right="Tips as money you hold">
              Tips, security deposits, gift cards and staff commission are liabilities from the
              moment they arrive. They belong to somebody else until the day they do not.
            </Claim>
            <Claim wrong="Invoice the final cost" right="Invoice what was authorised">
              A repair order that runs past its estimate cannot be billed until the customer agrees
              again — and the approval records who said yes, when, and down which channel.
            </Claim>
            <Claim wrong="Plug the difference" right="Name the difference">
              What the till says and what is in the drawer are two numbers. Where they differ, the
              variance is posted as a variance rather than absorbed into sales.
            </Claim>
            <Claim wrong="A receivables total" right="A receivable per customer">
              What the balance sheet says you are owed, the aging report can attribute to somebody
              by name — and a scheduled check reports the moment those two stop agreeing.
            </Claim>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Industries, counted out by what they actually switch on.          */}
        {/* ---------------------------------------------------------------- */}
        <section className="border-y border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 className="max-w-2xl text-2xl font-semibold tracking-tight">
              {PACKS.length} trades, one set of books
            </h2>
            <p className="mt-3 max-w-2xl text-muted">
              Your trade decides which accounts you start with, which workspaces switch on, and what
              the screens call a customer. It never forks the accounting model, so your accountant
              opens the books they expect — {EXTRA_ACCOUNTS} specialised accounts across the packs,
              all inside the standard numbering.
            </p>

            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {REAL_PACKS.map((pack) => (
                <div className="card flex flex-col gap-3 px-5 py-4" key={pack.key}>
                  <div>
                    <h3 className="text-sm font-semibold">{pack.label}</h3>
                    <p className="mt-0.5 text-xs text-faint">
                      +{pack.accounts.length} accounts
                      {pack.terminology?.customer
                        ? ` · calls them ${pack.terminology.customer.toLowerCase()}s`
                        : ''}
                    </p>
                  </div>
                  <ul className="mt-auto flex flex-wrap gap-1.5">
                    {pack.modules.map((module) => (
                      <li className="chip bg-raised text-muted" key={module}>
                        {MODULE_LABELS[module]}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <p className="mt-6 text-sm text-faint">
              Not listed? &ldquo;General&rdquo; gives you the standard chart with nothing switched
              on, and every module can be turned on afterwards.
            </p>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* The accountant. A second audience, and a real differentiator.     */}
        {/* ---------------------------------------------------------------- */}
        <section className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:items-start">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-action">
                For the firm
              </p>
              <h2 className="mt-4 text-2xl font-semibold tracking-tight">
                Your accountant, without the email attachments
              </h2>
              <p className="mt-3 text-muted">
                A practice works across its clients&rsquo; books from one sign-in, switching between
                companies without a second password. Staff are assigned per client, and assignment
                is what grants access — not a role somebody remembered to set.
              </p>
              <p className="mt-3 text-muted">
                The client sees the same list from their side: exactly who at the firm can open
                their books, and one control to stop them.
              </p>
            </div>

            <ul className="space-y-3">
              <Point title="One work queue across every client">
                What is late, what is due, and what nobody has claimed — across the whole practice
                rather than one company at a time.
              </Point>
              <Point title="Notes on any record">
                A question about a transaction lives on the transaction, where the next person to
                open it will find it.
              </Point>
              <Point title="Evidence attached to the entry">
                Receipts and documents hang off the thing they support, so a review does not start
                with a folder hunt.
              </Point>
              <Point title="Bring the last system with you">
                Import a chart of accounts, contacts and opening balances through Opening Balance
                Equity — with a dry run first, and a reversal if it went wrong.
              </Point>
            </ul>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Close.                                                            */}
        {/* ---------------------------------------------------------------- */}
        <section className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-6 py-20 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">Start with your own books</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted">
              Set up a company, pick your trade, and you have a chart of accounts and a ledger that
              balances. Nothing to import before you can look around.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link className="btn btn-primary" href="/register">
                Set up your company
              </Link>
              <Link className="btn" href="/login">
                Sign in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-sm text-faint">
          <span>Accountrix Plus</span>
          <span>Double-entry bookkeeping, audited by design.</span>
        </div>
      </footer>
    </div>
  )
}

/**
 * A real entry, balanced, shown rather than described.
 *
 * The card-fee case is the one on the page it illustrates: the money that
 * arrived in the bank is not the sale, and an entry that treats it as the sale
 * understates revenue and hides a cost. Three lines, two of them debits, and
 * the totals agree — which is the whole argument of the page in one object.
 */
function JournalDemo() {
  const lines = [
    { account: '1010 · Bank', debit: '940.00', credit: null },
    { account: '6120 · Card processing fees', debit: '60.00', credit: null },
    { account: '4010 · Sales', debit: null, credit: '1,000.00' },
  ]

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <p className="text-sm font-semibold">Card settlement</p>
          <p className="text-xs text-faint">Posted by Sam · 14 March</p>
        </div>
        <span className="chip bg-raised text-positive">Balanced</span>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-faint">
            <th className="px-5 py-2 text-left font-medium">Account</th>
            <th className="px-3 py-2 text-right font-medium">Debit</th>
            <th className="px-5 py-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr className="border-t border-line" key={line.account}>
              <td className="px-5 py-2.5 text-muted">{line.account}</td>
              <td className="tnum px-3 py-2.5 text-right">{line.debit ?? ''}</td>
              <td className="tnum px-5 py-2.5 text-right">{line.credit ?? ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line font-semibold">
            <td className="px-5 py-2.5 text-xs uppercase tracking-wide text-faint">Totals</td>
            <td className="tnum px-3 py-2.5 text-right">1,000.00</td>
            <td className="tnum px-5 py-2.5 text-right">1,000.00</td>
          </tr>
        </tfoot>
      </table>

      <p className="border-t border-line px-5 py-3 text-xs text-faint">
        $940 landed in the bank. The sale was still $1,000.
      </p>
    </div>
  )
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  )
}

/**
 * A refusal, shown as the swap it makes.
 *
 * The struck-through half is what the books would have said somewhere else. It
 * earns its place because the mistakes here are ones people do not recognise as
 * mistakes until they are named.
 */
function Claim({
  wrong,
  right,
  children,
}: {
  wrong: string
  right: string
  children: React.ReactNode
}) {
  return (
    <div className="card px-5 py-4">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="text-faint line-through decoration-negative/60">{wrong}</span>
        <span aria-hidden className="text-faint">
          →
        </span>
        <span className="font-semibold">{right}</span>
      </p>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  )
}

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="border-l-2 border-line pl-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted">{children}</p>
    </li>
  )
}
