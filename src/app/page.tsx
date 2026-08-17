import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor } from '@/lib/current-user'
import { INDUSTRY_PACKS } from '@/modules/coa/industry'

export const dynamic = 'force-dynamic'

/**
 * The public landing page.
 *
 * Signed-in visitors are sent to their books rather than shown marketing — the
 * home page is for people who do not have an account yet, and anybody who does
 * is trying to get to work.
 *
 * Everything claimed below is a thing the application does. That is a
 * deliberate constraint rather than modesty: a landing page that promises a
 * feature the product lacks is the fastest way to lose the first customer who
 * signs up, and this one is easy to keep honest because the sections map to
 * shipped phases.
 */
export default async function Home() {
  const actor = await currentActor()
  if (actor) redirect('/bookkeeping')

  const industries = Object.values(INDUSTRY_PACKS)

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <span className="text-sm font-semibold tracking-tight">Accountrix Plus</span>
          <nav className="flex items-center gap-2">
            <Link className="btn text-sm" href="/login">
              Sign in
            </Link>
            <Link className="btn btn-primary text-sm" href="/register">
              Set up your company
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Books that can always answer the question
            <span className="text-brand"> &ldquo;why?&rdquo;</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-muted">
            A double-entry accounting system for small businesses and the accountants who look
            after them. Every figure on every report traces back to an entry, and every entry says
            who made it and when.
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
            Free to set up. Choosing your industry installs a matching chart of accounts, which you
            can change afterwards.
          </p>
        </section>

        <section className="border-y border-line bg-surface">
          <div className="mx-auto grid max-w-5xl gap-8 px-6 py-16 sm:grid-cols-3">
            <Feature title="Real double-entry, not a spreadsheet">
              Debits equal credits or the entry does not post. Bank feeds, invoices, payroll, stock
              and depreciation all land in one ledger, so the trial balance is the trial balance.
            </Feature>
            <Feature title="Built for your trade">
              Ten industry modules — job costing, inventory, properties, funds, manufacturing, daily
              takings, appointments, vehicles and more — switched on by your industry and adjustable
              afterwards.
            </Feature>
            <Feature title="Your accountant, without the email">
              Practice mode lets a firm work across its clients&rsquo; books with per-client staff
              assignment, and shows each client exactly who at the firm can open theirs.
            </Feature>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">
            The kind of thing it refuses to get wrong
          </h2>
          <p className="mt-2 max-w-2xl text-muted">
            Most of the work in an accounting system is in the cases nobody demos.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <Claim title="A booking is a promise, not a sale">
              Nothing posts until the service is delivered, so your revenue is what you earned and
              not what your diary happens to hold.
            </Claim>
            <Claim title="Nobody bills past what was authorised">
              A repair order that runs over its estimate cannot be invoiced until the customer says
              yes again — and every approval records who, when, and down which channel.
            </Claim>
            <Claim title="Gross, not net">
              A card processor that deposits £940 on £1,000 of sales did not make £940 of sales.
              The fee is a cost, and the revenue is what the customer paid.
            </Claim>
            <Claim title="Somebody else&rsquo;s money stays theirs">
              Tips, security deposits, gift cards and staff commission are liabilities from the
              moment they arrive — never revenue, and never quietly spent.
            </Claim>
            <Claim title="The till is counted, and the difference is named">
              What the register says and what is in the drawer are two numbers. Where they differ,
              the gap is recorded rather than plugged.
            </Claim>
            <Claim title="What is owed is owed by somebody">
              What the balance sheet says you are owed, the aging report can attribute to a
              customer — and a report tells you the moment those two stop agreeing.
            </Claim>
          </div>
        </section>

        <section className="border-t border-line bg-surface">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">
              {industries.length} industries, one set of books
            </h2>
            <p className="mt-2 max-w-2xl text-muted">
              Your industry decides the accounts you start with and the modules that are switched
              on. It never creates a separate kind of accounting, so your accountant sees the books
              they expect.
            </p>

            <ul className="mt-6 flex flex-wrap gap-2">
              {industries.map((pack) => (
                <li className="chip border border-line bg-raised text-muted" key={pack.key}>
                  {pack.label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-20 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">Start with your own books</h2>
          <p className="mx-auto mt-2 max-w-xl text-muted">
            Set up a company, pick your industry, and you have a chart of accounts and a ledger in
            about a minute.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link className="btn btn-primary" href="/register">
              Set up your company
            </Link>
            <Link className="btn" href="/login">
              Sign in
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-sm text-faint">
          <span>Accountrix Plus</span>
          <span>Double-entry bookkeeping, audited by design.</span>
        </div>
      </footer>
    </div>
  )
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted">{children}</p>
    </div>
  )
}

function Claim({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card px-5 py-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted">{children}</p>
    </div>
  )
}
