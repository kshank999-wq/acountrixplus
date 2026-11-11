import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, communications, organizations, vendors } from '@/db/schema'
import { createVendor } from '@/modules/receivables/service'
import {
  listVendorSummaries,
  setVendorOrganization,
} from '@/modules/parties/service'
import { createOrganization } from '@/modules/crm/opportunities'
import { sendRemittanceEmail } from '@/modules/notify/service'
import { mockTransactionalProvider } from '@/modules/notify/transactional'
import { CUSTOMER_FIELDS, VENDOR_FIELDS } from '@/modules/parties/changes'
import { COLUMN_WRITERS, writerCandidates } from '@/modules/source/column-writers'
import { addUserWithRole, createCompanyFixture, type Fixture } from './helpers'

/**
 * The supplier who is also a client (Phase 208, spec §6, §16, §19).
 *
 * ## The column one module existed for and nothing could write
 *
 * `organizations` is this application's one party record, and customer and
 * vendor are **accounting roles** it plays — `customers.organizationId` and
 * `vendors.organizationId` point back at it, because *"a firm you both buy
 * from and sell to is one organization with two accounting roles, not two
 * conflicting rows"*.
 *
 * `engagement/filing.ts` spends a whole module on that firm. A remittance
 * advice is a payables document and files on the supplier; an invoice on the
 * customer; and `columnsFor` carries the organisation along *"whenever the
 * party has one"*, so a letter to a trading party who is also a CRM client
 * also appears on that client's timeline.
 *
 * For a vendor the party never had one. `crm/conversion.ts` writes the
 * customer side when an opportunity is won; `createVendor` has no such input
 * and `updateVendor` has no such field. So the one case `filing.ts` exists for
 * was the one case it could not serve, for 207 phases.
 *
 * ## Why five ADRs declared it rather than closing it
 *
 * ADRs 0201–0207 each carried the same reason forward: the vendor correction
 * screen is driven by `VENDOR_FIELDS`, a registry of **text fields** whose
 * three-way `kind` says what changing one means, so a link to a CRM record
 * would be a new *kind* of field — and `diffParty` would print a uuid into an
 * audit trail that exists because changing a supplier's details is the
 * commonest invoice-fraud vector a small business meets.
 *
 * Every clause of that is true and the conclusion is not. **The customer side
 * is not a field either**, which is asserted below rather than asserted in
 * prose: `CUSTOMER_FIELDS` has no `organizationId` entry at all. The link is
 * written by an *act*, and the people board already carries one beside the
 * correction form — `mergeParties`, which takes two record ids, shows what
 * would move, refuses a blank reason and writes both records' history.
 *
 * So `VENDOR_FIELDS` learns nothing, and the audit entry carries the
 * organisation's **name**.
 */

let fixture: Fixture

/**
 * The real send path, with the provider mocked and nothing else.
 *
 * `recordOutboundMail` on its own takes a `transactionalMessageId` that a
 * foreign key refuses, and it swallows every error by design — a log that
 * cannot be written must not stop a password reset going out. So a test that
 * called it directly with a made-up id would get `null` and pass nothing,
 * which is why this goes through `sendRemittanceEmail`: the filing is the
 * thing under test and it has to be the filing the application does.
 */
const mail = mockTransactionalProvider()

beforeEach(async () => {
  mail.reset()
  fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
})

const SHARED = 'accounts@harborview.test'

async function client(name = 'Harborview Partners', email = SHARED) {
  return createOrganization(fixture.ctx, { name, email, lifecycleStage: 'active_client' })
}

async function supplier(name = 'Harborview Partners', email: string | undefined = SHARED) {
  return createVendor(fixture.ctx, { name, email, allowNamesake: true })
}

/** Every audit action this company has recorded, in order. */
async function actions() {
  return (
    await db
      .select({ action: auditEvents.action, before: auditEvents.before, after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.companyId, fixture.companyId))
  ).filter((row) => row.action.endsWith('_organization'))
}

/** One remittance advice, through the real send path. */
async function remittance(reference: string) {
  return sendRemittanceEmail({
    to: SHARED,
    toName: 'Harborview Partners',
    companyId: fixture.companyId,
    companyName: 'Ridgeline Construction',
    amount: '$500.00',
    summary: 'One bill settled.',
    token: `tok_${reference}`,
    isResend: false,
    reference,
  })
}

/** The one communications row filed for this company, whatever it is on. */
async function filed() {
  const rows = await db
    .select({
      vendorId: communications.vendorId,
      customerId: communications.customerId,
      organizationId: communications.organizationId,
    })
    .from(communications)
    .where(eq(communications.companyId, fixture.companyId))

  expect(rows).toHaveLength(1)
  return rows[0]
}

describe('the remittance that never reached the client’s timeline', () => {
  /**
   * The live defect, end to end and from the reader's side.
   *
   * One shared inbox that is both a CRM client and a supplier. `KIND_CONCERNS`
   * sends a remittance to the **vendor**, which is right and is the whole
   * point of that module — and before this phase it was also the end of the
   * story, because the vendor had no organisation to carry along.
   */
  it('files on the supplier and on nobody else, until the link exists', async () => {
    const organization = await client()
    const vendor = await supplier()

    await remittance('rem-208-a')

    const before = await filed()

    // Filed against the supplier, correctly. And against no client at all,
    // which is the defect: the firm on the other end of that payment is a
    // client of ours, and their timeline does not know we wrote to them.
    expect(before.vendorId).toBe(vendor.id)
    expect(before.organizationId).toBeNull()
    expect(organization.id).not.toBe(vendor.id)
  })

  it('reaches both once the supplier is linked to the client it is', async () => {
    const organization = await client()
    const vendor = await supplier()

    await setVendorOrganization(fixture.ctx, {
      vendorId: vendor.id,
      organizationId: organization.id,
    })

    await remittance('rem-208-b')

    const row = await filed()

    expect(row.vendorId).toBe(vendor.id)
    expect(row.organizationId).toBe(organization.id)

    /*
      And still not on the customer side.

      This is the harm `filing.ts` exists to prevent and the link must not
      reintroduce: our own payment advice stored against somebody's debt to us,
      where the next person to open that customer reads it as something we sent
      them about what they owe. The organisation comes along; the side of the
      books does not move.
    */
    expect(row.customerId).toBeNull()
  })
})

describe('an act, not a field', () => {
  /**
   * The measurement that dissolved five ADRs' stated blocker.
   *
   * The reason given for declaring this column rather than closing it was that
   * `VENDOR_FIELDS` would have to learn a new *kind* of field. Asserted here
   * on the registries themselves, because the counter-argument is a fact about
   * them: the customer side of the identical link has no entry either, so a
   * field was never how this is written.
   */
  it('is in neither party registry, on either side', () => {
    expect(VENDOR_FIELDS.map((field) => field.key)).not.toContain('organizationId')
    expect(CUSTOMER_FIELDS.map((field) => field.key)).not.toContain('organizationId')

    // And the three kinds a field can be are untouched, which is the claim
    // "the registry learns nothing" made checkable.
    expect(new Set(VENDOR_FIELDS.map((field) => field.kind))).toEqual(
      new Set(['description', 'default', 'consequence']),
    )
  })

  it('writes the organisation’s name into the audit trail, not its id', async () => {
    const organization = await client()
    const vendor = await supplier()

    await setVendorOrganization(fixture.ctx, {
      vendorId: vendor.id,
      organizationId: organization.id,
    })

    const [linked] = await actions()

    expect(linked.action).toBe('vendor.link_organization')
    expect(linked.after).toEqual({ organization: 'Harborview Partners' })
    expect(JSON.stringify(linked)).not.toContain(organization.id)
  })

  it('does not move the client’s lifecycle stage', async () => {
    /**
     * A lifecycle stage holds one value, so writing `'vendor'` over
     * `'active_client'` would delete the more important half of the fact being
     * recorded. That a single stage cannot say "both" is the reason the link
     * column exists at all, and `'vendor'` stays the stage §6 lists for a firm
     * that only sells to us.
     */
    const organization = await client()
    const vendor = await supplier()

    await setVendorOrganization(fixture.ctx, {
      vendorId: vendor.id,
      organizationId: organization.id,
    })

    const [row] = await db
      .select({ stage: organizations.lifecycleStage })
      .from(organizations)
      .where(eq(organizations.id, organization.id))

    expect(row.stage).toBe('active_client')
  })

  it('says nothing when nothing changed', async () => {
    // Re-saving a form is not an event. An audit log in which it is one is a
    // log with the real change buried in it.
    const organization = await client()
    const vendor = await supplier()

    for (const _ of [1, 2, 3]) {
      await setVendorOrganization(fixture.ctx, {
        vendorId: vendor.id,
        organizationId: organization.id,
      })
    }

    expect(await actions()).toHaveLength(1)
  })
})

describe('the undo, in the same phase', () => {
  /**
   * Phase 206's finding, applied before it could happen again.
   *
   * `deactivateServiceItem` moved `isActive` in one direction only from Phase
   * 4 to Phase 206 — invisible to the column census *and* to its mirror,
   * because the column is read and written, and indistinguishable from a
   * working control until somebody wanted it back.
   */
  it('takes the link away and names what it was', async () => {
    const organization = await client()
    const vendor = await supplier()

    await setVendorOrganization(fixture.ctx, {
      vendorId: vendor.id,
      organizationId: organization.id,
    })
    const result = await setVendorOrganization(fixture.ctx, {
      vendorId: vendor.id,
      organizationId: null,
    })

    expect(result.linked).toBe(false)
    expect(result.organizationName).toBe('Harborview Partners')

    const [row] = await db
      .select({ organizationId: vendors.organizationId })
      .from(vendors)
      .where(eq(vendors.id, vendor.id))
    expect(row.organizationId).toBeNull()

    const log = await actions()
    expect(log.map((one) => one.action)).toEqual([
      'vendor.link_organization',
      'vendor.unlink_organization',
    ])

    /*
      The name is read *before* the write, because afterwards there is nothing
      left to read it from. An entry saying a link was removed without saying
      to what is an entry nobody can act on — which is the same argument Phase
      97 made for recording which invoices a merge moved rather than how many.
    */
    expect(log[1].before).toEqual({ organization: 'Harborview Partners' })
    expect(log[1].after).toEqual({ organization: null })
  })

  it('refuses to unlink what was never linked', async () => {
    const vendor = await supplier('Plant Hire Ltd', 'hire@plant.test')

    await expect(
      setVendorOrganization(fixture.ctx, { vendorId: vendor.id, organizationId: null }),
    ).rejects.toThrow(/not linked to a client record/)

    expect(await actions()).toHaveLength(0)
  })
})

describe('the four refusals', () => {
  it('refuses a vendor that is not on these books', async () => {
    const organization = await client()

    await expect(
      setVendorOrganization(fixture.ctx, {
        vendorId: '00000000-0000-0000-0000-000000000000',
        organizationId: organization.id,
      }),
    ).rejects.toThrow(/not on these books/)
  })

  it('refuses a client that is not on these books', async () => {
    const vendor = await supplier()

    await expect(
      setVendorOrganization(fixture.ctx, {
        vendorId: vendor.id,
        organizationId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/client is not on these books/)
  })

  it('refuses to move a link rather than moving it quietly', async () => {
    /**
     * The refusal with the longest argument behind it.
     *
     * The link decides which client's timeline this supplier's letters land
     * on, and a remittance already filed against the old organisation **stays
     * filed there** — `communications` records what was true when the letter
     * went. So repointing would leave one firm's payment advice on another
     * firm's record with nothing saying it had moved. Unlinking first makes
     * that a thing somebody did on purpose, and the log has a word for it.
     */
    const first = await client('Harborview Partners')
    const second = await client('Summit Developments', 'ap@summit.test')
    const vendor = await supplier()

    await setVendorOrganization(fixture.ctx, {
      vendorId: vendor.id,
      organizationId: first.id,
    })

    await expect(
      setVendorOrganization(fixture.ctx, {
        vendorId: vendor.id,
        organizationId: second.id,
      }),
    ).rejects.toThrow(/already linked to Harborview Partners/)

    // Named, not numbered. A refusal that says "already linked" and leaves
    // somebody to find out to what is a refusal they cannot act on.
    const [row] = await db
      .select({ organizationId: vendors.organizationId })
      .from(vendors)
      .where(eq(vendors.id, vendor.id))
    expect(row.organizationId).toBe(first.id)
  })

  it('refuses a second supplier for one client, and names the escape', async () => {
    /**
     * The customer side has read this as one-per-organisation since Phase 45:
     * `crm/conversion.ts` takes the first customer linked to the organisation
     * and adopts an unlinked namesake rather than creating a second, because
     * two records for one client split their aging, their statement and their
     * balance. Two supplier rows for one client would split that client's
     * payables the same way.
     */
    const organization = await client()
    const one = await supplier('Harborview Partners')
    const two = await supplier('Harborview Partners (old)', 'old@harborview.test')

    await setVendorOrganization(fixture.ctx, {
      vendorId: one.id,
      organizationId: organization.id,
    })

    await expect(
      setVendorOrganization(fixture.ctx, {
        vendorId: two.id,
        organizationId: organization.id,
      }),
    ).rejects.toThrow(/already linked to the supplier Harborview Partners\./)
  })
})

describe('who may do it', () => {
  /**
   * Both permissions, and neither standing in for the other — which the role
   * table makes a real case rather than a hypothetical one.
   *
   * An **accountant** has `accounting:journal` and no `crm:view`, so the role
   * most likely to be editing a supplier is refused: naming a client by trying
   * ids is exactly the disclosure `crm:view` exists to prevent, and the board
   * hides the picker *and the linked client's name* from that reader for the
   * same reason the page already hides the customer side.
   *
   * **Sales** has `crm:view` and no `accounting:journal`, which is the other
   * half: reading the client list is not permission to change where money
   * goes.
   */
  it('needs the client list and the supplier record both', async () => {
    const organization = await client()
    const vendor = await supplier()

    const accountant = await addUserWithRole(fixture, 'accountant')
    await expect(
      setVendorOrganization(accountant, {
        vendorId: vendor.id,
        organizationId: organization.id,
      }),
    ).rejects.toThrow()

    const sales = await addUserWithRole(fixture, 'sales')
    await expect(
      setVendorOrganization(sales, {
        vendorId: vendor.id,
        organizationId: organization.id,
      }),
    ).rejects.toThrow()

    // The owner has both, and the link is made.
    await setVendorOrganization(fixture.ctx, {
      vendorId: vendor.id,
      organizationId: organization.id,
    })

    const [row] = await db
      .select({ organizationId: vendors.organizationId })
      .from(vendors)
      .where(and(eq(vendors.id, vendor.id), eq(vendors.companyId, fixture.companyId)))
    expect(row.organizationId).toBe(organization.id)
  })
})

describe('what the board is given', () => {
  it('carries the client’s name rather than its id', async () => {
    /*
      The summary carries the *name*, for the reason the merge pointer beside
      it does: a panel holding only the id has to ask a second question to say
      anything a person can read, and the screen that cannot ask it shows a
      uuid. Phase 97 found the same thing of `mergedIntoId` — written in Phase
      96 and read by nothing, so an absorbed record showed as a bare "archived"
      with no documents.
    */
    const organization = await client()
    const vendor = await supplier()

    await setVendorOrganization(fixture.ctx, {
      vendorId: vendor.id,
      organizationId: organization.id,
    })

    const rows = await listVendorSummaries(fixture.ctx)
    const linked = rows.find((row) => row.id === vendor.id)

    expect(linked?.organization).toEqual({
      id: organization.id,
      name: 'Harborview Partners',
    })

    const other = await supplier('Plant Hire Ltd', 'hire@plant.test')
    expect(
      (await listVendorSummaries(fixture.ctx)).find((row) => row.id === other.id)?.organization,
    ).toBeNull()
  })

  it('hides the picker and the name from a reader who may not see the CRM', () => {
    /*
      Asserted on the source, because the claim is about what the server hands
      the browser. The board takes `clients` as a list **or null**, and null
      hides the link's name as well as the control — an empty list would have
      hidden only the control and still printed the client's name on the row.
    */
    const page = readFileSync('src/app/accounting/people/page.tsx', 'utf8')
    expect(page).toContain("can(actor, 'crm:view')")
    expect(page).toContain('Promise.resolve(null)')

    const board = readFileSync('src/app/accounting/people/board.tsx', 'utf8')
    expect(board).toContain('clients: { id: string; name: string }[] | null')
    expect(board).toContain('isVendors && clients !== null && (row as Vendor).organization')
  })
})

describe('the column census, with nothing left in it', () => {
  it('no longer reports the column, which is what proves an editor reaches it', () => {
    /**
     * The register's own rule, in both directions: every candidate is
     * **declared or fixed**, and a closed one is *absent* rather than left
     * with an entry that would excuse it.
     *
     * So this is the assertion that the write is real. A declaration saying
     * "something writes this" cannot be checked; the scan no longer seeing the
     * column can.
     */
    const candidates = writerCandidates().map((one) => `${one.table}.${one.column}`)

    expect(candidates).not.toContain('vendors.organizationId')

    /*
      The count itself is asserted in `a-column-nobody-could-fill`, which owns
      this register's invariants — including that no entry is a finding any
      more. Two test files holding one count is what reddened shards 3, 4, 5
      and 6 across Phases 204–207, and the fix each time was to give the claim
      one home rather than to update both. What this file owns is its own
      column and the word the register keeps for the next one.
    */
    expect(COLUMN_WRITERS.some((row) => row.table === 'vendors')).toBe(false)
  })

  it('keeps the word for a finding, with nothing carrying it', () => {
    /*
      Phase 157's rule: an unused declaration stays when it *accuses*. The
      `unwritable` verdict is this register's word for a finding, and a
      register with no vocabulary for one cannot report the next — the five
      phases it took to close `vendors.organizationId` are the argument for
      leaving it where it is rather than deleting it as dead code.
    */
    const source = readFileSync('src/modules/source/column-writers.ts', 'utf8')

    expect(source).toContain("| 'unwritable'")
    expect(source).toContain('No entry carries this verdict as of Phase 208')
    // And the heading it would go under, so the next finding has a place.
    expect(source).toContain('--- Unwritable, and recorded as findings ---')
  })
})
