'use client'

import { Fragment, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  mergePartiesAction,
  mergePreviewAction,
  setCustomerActiveAction,
  setVendorActiveAction,
  updateCustomerAction,
  updateVendorAction,
  type ActionResult,
} from '@/app/actions/parties'
import { formatCents } from '@/lib/money'
import { partyStanding } from '@/modules/parties/standing'
import type { Resolution } from '@/modules/parties/duplicates'
import { correction } from '@/modules/corrections/vocabulary'
import { describeArchived } from '@/modules/parties/merged'
import { RecordHistory } from '@/components/record-history'
import { PartyPost } from '@/components/party-post'

type Party = {
  id: string
  name: string
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  region: string | null
  postalCode: string | null
  paymentTermsDays: number
  notes: string | null
  isActive: boolean
  openDocuments: number
  /** Home currency since Phase 56 — it used to sum face amounts across them. */
  balanceCents: number
  /**
   * Their overpayment, or their unspent credit against us (Phase 56), in the
   * home currency since Phase 65 — it summed face amounts before that and was
   * netted against a converted balance.
   */
  heldCreditCents: number
  /** What that figure stands for, when some of it arrived in another currency. */
  heldCreditNote: string | null
  oldestDueDate: string | null
  hasForeignDocuments: boolean
  documentCount: number
  /** Where it went, when it was merged away rather than retired (Phase 97). */
  mergedInto: { id: string; name: string } | null
}

type Vendor = Party & { taxId: string | null; is1099Vendor: boolean }

type Draft = Record<string, string | boolean>

/**
 * The words for a merge, from the one list that owns them (Phase 70).
 *
 * Read here rather than typed into the JSX, so this screen cannot drift into
 * calling it something no other screen calls it.
 */
const MERGE = correction('party.merge')

/**
 * Every customer and supplier, and the form that corrects one.
 *
 * The form is inline rather than a page of its own. Somebody opening this
 * screen has almost always just seen a wrong email on an invoice, and a
 * correction that costs two navigations is one people work around by making a
 * second customer instead — which is the thing this phase exists to stop.
 */
export function PeopleBoard({
  customers,
  vendors,
  canEditCustomers,
  canEditVendors,
  asOf,
  homeCurrency,
  sharedAddresses,
}: {
  customers: Party[]
  vendors: Vendor[]
  canEditCustomers: boolean
  canEditVendors: boolean
  /** Today, decided on the server so every reader sees the same ages. */
  asOf: string
  homeCurrency: string
  /**
   * What the nightly register found, resolved (Phase 95).
   *
   * The finding has existed since Phase 94 and lived only on the operations
   * page. This is the screen where somebody would actually fix it, so the
   * problem is put in front of them here rather than leaving them to carry it
   * across from another page and match the names up by eye.
   */
  sharedAddresses: Resolution[]
}) {
  const router = useRouter()
  const [side, setSide] = useState<'customers' | 'vendors'>('customers')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<string | null>(null)

  /** Which row has its history open (Phase 71). */
  const [historyId, setHistoryId] = useState<string | null>(null)
  /** What we have *sent* them, which is not what *changed* (Phase 93). */
  const [postId, setPostId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [showArchived, setShowArchived] = useState(false)

  /**
   * The clash being merged, which record is to survive, and why (Phase 96).
   *
   * Kept in one piece of state rather than three: a half-filled merge form
   * belonging to a different address than the one on screen is exactly the
   * confusion this panel exists to end.
   */
  const [merging, setMerging] = useState<{
    address: string
    keepId: string
    reason: string
    preview: string | null
  } | null>(null)

  const isVendors = side === 'vendors'
  const canEdit = isVendors ? canEditVendors : canEditCustomers
  const all: Array<Party | Vendor> = isVendors ? vendors : customers
  const rows = all.filter((row) => showArchived || row.isActive)
  const archivedCount = all.filter((row) => !row.isActive).length

  /** The clashes on the side being looked at. A supplier's is not a customer's. */
  const clashes = sharedAddresses.filter(
    (one) => one.side === (isVendors ? 'vendor' : 'customer'),
  )

  /**
   * Which rows are caught in one, so a long list can be scanned for them.
   *
   * The panel names them, but on four hundred customers "Cascade Joinery" is
   * still a thing to go and find. The mark is what connects the two.
   */
  const flagged = new Map(
    clashes.flatMap((clash) =>
      clash.dispositions.map((one) => [one.id, clash] as const),
    ),
  )

  function act(fn: () => Promise<ActionResult>, onOk?: () => void) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok ? { ok: true, text: result.message ?? 'Done.' } : { ok: false, text: result.error },
      )
      if (result.ok) {
        onOk?.()
        router.refresh()
      }
    })
  }

  function open(row: Party | Vendor) {
    // A notice is about the record it was raised on. Left up while somebody
    // opens a different one, "there is still money outstanding" reads as being
    // about whoever is now in front of them — which browser verification found
    // it doing, on a supplier owing nothing.
    setNotice(null)
    setEditing(row.id)
    setDraft({
      name: row.name,
      email: row.email ?? '',
      phone: row.phone ?? '',
      addressLine1: row.addressLine1 ?? '',
      addressLine2: row.addressLine2 ?? '',
      city: row.city ?? '',
      region: row.region ?? '',
      postalCode: row.postalCode ?? '',
      paymentTermsDays: String(row.paymentTermsDays),
      notes: row.notes ?? '',
      ...(isVendors
        ? {
            taxId: (row as Vendor).taxId ?? '',
            is1099Vendor: (row as Vendor).is1099Vendor,
          }
        : {}),
    })
  }

  function save(id: string) {
    const input = { id, ...draft }
    act(
      () => (isVendors ? updateVendorAction(input) : updateCustomerAction(input)),
      () => setEditing(null),
    )
  }

  const set = (key: string) => (value: string | boolean) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const field = (key: string, label: string, hint?: string) => (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        className="field py-1.5 text-sm"
        value={String(draft[key] ?? '')}
        onChange={(event) => set(key)(event.target.value)}
      />
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  )

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Customers and suppliers</h2>
        <p className="text-sm text-muted">
          Everybody the business trades with.{' '}
          <span className="text-faint">
            A name or an address here is a description — correcting one corrects it everywhere it
            appears, including on invoices already sent. Payment terms are a default, and only
            reach the next document.
          </span>
        </p>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          <p className="whitespace-pre-line">{notice.text}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`btn text-sm ${side === 'customers' ? 'btn-primary' : ''}`}
          onClick={() => {
            setSide('customers')
            setEditing(null)
            setNotice(null)
          }}
        >
          Customers ({customers.filter((row) => row.isActive).length})
        </button>
        <button
          type="button"
          className={`btn text-sm ${side === 'vendors' ? 'btn-primary' : ''}`}
          onClick={() => {
            setSide('vendors')
            setEditing(null)
            setNotice(null)
          }}
        >
          Suppliers ({vendors.filter((row) => row.isActive).length})
        </button>

        {archivedCount > 0 && (
          <button
            type="button"
            className="ml-auto text-xs text-faint underline"
            onClick={() => setShowArchived((open) => !open)}
          >
            {showArchived ? 'Hide' : 'Show'} {archivedCount} archived
          </button>
        )}
      </div>

      {clashes.length > 0 && (
        <section className="card border-warning/40 px-4 py-3">
          <h2 className="text-sm font-semibold">
            {clashes.length === 1
              ? 'One address is shared'
              : `${clashes.length} addresses are shared`}
          </h2>
          <p className="mt-1 text-xs text-muted">
            When {isVendors ? 'suppliers' : 'customers'} share an inbox, all of them are chased
            there and no letter says which account it refers to. Sharing an address does not make
            them the same business — that part is your call.
          </p>

          <ul className="mt-3 space-y-3">
            {clashes.map((clash) => (
              <li key={`${clash.side} ${clash.address}`} className="text-xs">
                <p className="font-medium">{clash.address}</p>
                <ul className="mt-1 space-y-0.5">
                  {clash.dispositions.map((one) => (
                    <li key={one.id} className="text-muted">
                      <span className="font-medium text-fg">{one.name}</span>{' '}
                      {/*
                        The evidence, not just the conclusion. "Never invoiced"
                        is a fact somebody can check; "archive this one" is
                        something they would have to take on trust.
                      */}
                      {one.standing === 'untouched'
                        ? '— never invoiced'
                        : one.standing === 'settled'
                          ? '— has documents, nothing outstanding'
                          : '— open documents or money held'}
                      {one.retirable && (
                        <span className="ml-1 text-faint">can be archived</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-muted">{clash.because}</p>

                {/*
                  Offered only where Phase 95 had no answer, and only for two
                  records. Three on one address is a sequence of decisions, and
                  a control that quietly merged all of them would be making two
                  of those decisions on somebody's behalf.
                */}
                {clash.advice === 'merge' && clash.dispositions.length === 2 && canEdit && (
                  merging?.address === clash.address ? (
                    <div className="mt-2 space-y-2 rounded border border-line p-2">
                      <p className="font-medium">Which record survives?</p>
                      {clash.dispositions.map((one) => (
                        <label key={one.id} className="flex items-center gap-2">
                          <input
                            type="radio"
                            name={`keep-${clash.address}`}
                            checked={merging.keepId === one.id}
                            onChange={() =>
                              setMerging({ ...merging, keepId: one.id, preview: null })
                            }
                          />
                          <span>Keep {one.name}</span>
                        </label>
                      ))}

                      {merging.preview && <p className="text-muted">{merging.preview}</p>}

                      <label className="block">
                        <span className="text-muted">
                          {MERGE.reasonPrompt}
                        </span>
                        <textarea
                          className="input mt-1 w-full text-xs"
                          rows={2}
                          value={merging.reason}
                          onChange={(event) =>
                            setMerging({ ...merging, reason: event.target.value })
                          }
                        />
                      </label>

                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn btn-primary text-xs"
                          disabled={pending}
                          onClick={() => {
                            const loser = clash.dispositions.find(
                              (one) => one.id !== merging.keepId,
                            )!
                            act(
                              () =>
                                mergePartiesAction({
                                  side: clash.side,
                                  winnerId: merging.keepId,
                                  loserId: loser.id,
                                  reason: merging.reason,
                                }),
                              () => setMerging(null),
                            )
                          }}
                        >
                          {MERGE.verb}
                        </button>
                        <button
                          type="button"
                          className="btn text-xs"
                          onClick={() => setMerging(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="mt-1 text-xs underline"
                      onClick={() => {
                        const [first, second] = clash.dispositions
                        setNotice(null)
                        setMerging({
                          address: clash.address,
                          keepId: first.id,
                          reason: '',
                          preview: null,
                        })
                        // What it would move, from the same registry the merge
                        // walks. An irreversible act shows its work first.
                        startTransition(async () => {
                          const result = await mergePreviewAction({
                            side: clash.side,
                            winnerId: first.id,
                            loserId: second.id,
                          })
                          if (result.ok) {
                            setMerging((current) =>
                              current?.address === clash.address
                                ? { ...current, preview: result.line }
                                : current,
                            )
                          }
                        })
                      }}
                    >
                      {MERGE.title}
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {rows.length === 0 ? (
        <section className="card px-4 py-8 text-center">
          <p className="text-sm font-medium">
            No {isVendors ? 'suppliers' : 'customers'} yet.
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            They are created when you raise an invoice or enter a bill. Once one exists, this is
            where you correct it.
          </p>
        </section>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Where</th>
                <th className="px-4 py-2 text-right">Terms</th>
                <th className="px-4 py-2 text-right">Outstanding</th>
                <th className="px-4 py-2">Standing</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                /**
                 * Computed once per row, and from `asOf` rather than the
                 * browser's clock — this is a client component, and a figure
                 * that depends on the reader's machine is one two people
                 * disagree about (Phase 56).
                 */
                const standing = partyStanding({
                  owedCents: row.balanceCents,
                  heldCents: row.heldCreditCents,
                  oldestDueDate: row.oldestDueDate,
                  asOf,
                  side: isVendors ? 'vendor' : 'customer',
                  currency: homeCurrency,
                })

                return (
                <Fragment key={row.id}>
                <tr className="border-t border-line align-top">
                  {editing === row.id ? (
                    <td colSpan={7} className="px-4 py-4">
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {field('name', 'Name')}
                        {field(
                          'email',
                          'Email',
                          'Invoices and reminders go here. Clearing it stops both.',
                        )}
                        {field('phone', 'Phone')}
                        {field('addressLine1', 'Address', 'Printed on the invoice PDF.')}
                        {field('addressLine2', 'Address line 2')}
                        {field('city', 'City')}
                        {field('region', 'County or state')}
                        {field('postalCode', 'Postcode')}
                        {field(
                          'paymentTermsDays',
                          'Payment terms (days)',
                          'Applies to the next document. Ones already raised keep their due date.',
                        )}
                        {isVendors && field('taxId', 'Tax ID', 'Appears on a 1099.')}
                        {field('notes', 'Notes')}

                        {isVendors && (
                          <label className="flex items-center gap-2 self-end text-sm">
                            <input
                              type="checkbox"
                              checked={Boolean(draft.is1099Vendor)}
                              onChange={(event) => set('is1099Vendor')(event.target.checked)}
                            />
                            <span>Reportable on a 1099</span>
                          </label>
                        )}
                      </div>

                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="btn btn-primary text-sm"
                          disabled={pending}
                          onClick={() => save(row.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn text-sm"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>

                        <button
                          type="button"
                          className="ml-auto text-xs text-faint underline"
                          disabled={pending}
                          onClick={() =>
                            act(() =>
                              isVendors
                                ? setVendorActiveAction({ id: row.id, isActive: !row.isActive })
                                : setCustomerActiveAction({ id: row.id, isActive: !row.isActive }),
                            )
                          }
                        >
                          {row.isActive ? 'Archive' : 'Bring back'}
                        </button>
                      </div>
                    </td>
                  ) : (
                    <>
                      <td className="px-4 py-2">
                        <span className="font-medium">{row.name}</span>
                        {/*
                          "archived" and "merged into X" are different acts and
                          say so (Phase 97). Phase 96 wrote the pointer and
                          nothing read it, so an absorbed record showed as a
                          bare archived customer with no documents — which is
                          exactly the abandoned duplicate Phase 94 reports.
                        */}
                        {!row.isActive && (
                          <span className="ml-2 text-xs text-faint">
                            {describeArchived({
                              side: isVendors ? 'vendor' : 'customer',
                              isActive: row.isActive,
                              mergedInto: row.mergedInto,
                            })}
                          </span>
                        )}
                        {isVendors && (row as Vendor).is1099Vendor && (
                          <span className="ml-2 text-xs text-muted">1099</span>
                        )}
                        {row.documentCount > 0 && (
                          <span className="ml-2 text-xs text-faint">
                            {row.documentCount} document{row.documentCount === 1 ? '' : 's'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted">
                        {row.email ?? <span className="text-faint">none</span>}
                        {flagged.has(row.id) && (
                          <span
                            className="ml-2 text-xs text-warning"
                            title={flagged.get(row.id)?.because}
                          >
                            shared
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted">
                        {[row.city, row.postalCode].filter(Boolean).join(' ') || (
                          <span className="text-faint">none</span>
                        )}
                      </td>
                      <td className="tnum px-4 py-2 text-right text-muted">
                        {row.paymentTermsDays}d
                      </td>
                      {/*
                        The net, with the gross under it when they differ
                        (Phase 56). Showing only the net would leave somebody
                        unable to tie this to the invoices; showing only the
                        gross is what the screen used to do, and it asks for
                        money the business is already holding.
                      */}
                      <td className="tnum px-4 py-2 text-right">
                        {standing.position.dueCents === 0 &&
                        row.balanceCents === 0 &&
                        row.heldCreditCents === 0 ? (
                          <span className="text-faint">—</span>
                        ) : (
                          <>
                            <span
                              className={
                                standing.band === 'long_overdue' ? 'text-danger' : undefined
                              }
                            >
                              {formatCents(standing.position.dueCents, homeCurrency)}
                            </span>
                            {row.heldCreditCents > 0 && (
                              <span className="block text-xs text-faint">
                                {formatCents(row.balanceCents, homeCurrency)} billed
                              </span>
                            )}
                            {/* When the held figure is a conversion, say so and
                                say what it converts (Phase 65). Phase 61's
                                rule: a converted number shown without saying
                                so is the defect. */}
                            {row.heldCreditNote && (
                              <span className="mt-0.5 block text-xs text-warning">
                                {row.heldCreditNote}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <span
                          className={
                            standing.band === 'long_overdue'
                              ? 'text-danger'
                              : standing.band === 'overdue'
                                ? 'text-muted'
                                : 'text-faint'
                          }
                        >
                          {standing.note}
                        </span>
                        {/*
                          Said out loud rather than silently converted. The
                          figure beside it is the home-currency one, and a
                          customer billed in euros needs somebody to know that
                          before they quote it back down a phone (Phase 35).
                        */}
                        {row.hasForeignDocuments && (
                          <span className="block text-faint">
                            includes documents in another currency
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right">
                        {/*
                          Phase 71. Every edit here has recorded its before and
                          after since Phase 45 — the whole reason this screen
                          prefers an update to a delete and recreate — and
                          nothing could display either half until now. "Who
                          changed their email, and when" is the question the
                          audit trail exists to answer.
                        */}
                        <button
                          type="button"
                          className="btn btn-ghost text-xs"
                          onClick={() =>
                            setHistoryId((current) => (current === row.id ? null : row.id))
                          }
                        >
                          {historyId === row.id ? 'Hide history' : 'History'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost text-xs"
                          onClick={() =>
                            setPostId((current) => (current === row.id ? null : row.id))
                          }
                        >
                          {postId === row.id ? 'Hide post' : 'Post'}
                        </button>
                        {canEdit && (
                          <button
                            type="button"
                            className="btn btn-ghost text-xs"
                            onClick={() => open(row)}
                          >
                            Edit
                          </button>
                        )}
                      </td>
                    </>
                  )}
                </tr>

                {postId === row.id && editing !== row.id && (
                  <tr className="border-t border-line bg-raised/40">
                    <td colSpan={7} className="px-4 py-3">
                      <p className="mb-2 text-xs font-medium text-muted">
                        What we have sent them
                      </p>
                      <PartyPost
                        kind={isVendors ? 'vendor' : 'customer'}
                        partyId={row.id}
                      />
                    </td>
                  </tr>
                )}

                {historyId === row.id && editing !== row.id && (
                  <tr className="border-t border-line bg-raised/40">
                    <td colSpan={7} className="px-4 py-3">
                      <RecordHistory
                        entityType={isVendors ? 'vendor' : 'customer'}
                        entityId={row.id}
                        currency={homeCurrency}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
