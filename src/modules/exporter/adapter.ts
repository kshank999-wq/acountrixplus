/**
 * What every export adapter has to be able to do (Phase 158).
 *
 * Exporter spec §6 asks for *"an adapter-based architecture rather than
 * hard-coding each professional system into the accounting engine"*, and §8
 * lists the fourteen logical functions an adapter should implement. This is that
 * list as a type.
 *
 * ## Why a declared contract before there is a second adapter
 *
 * Normally this project would say the opposite — Phase 49's rule is that a
 * function with no caller is a feature that does not exist, and an interface
 * with one implementation is an interface shaped like its only implementation.
 *
 * Two things make this the other case. §15 requires that *"adapters can be
 * updated independently when a vendor changes its format or API"*, which is a
 * requirement about the seam and not about any adapter. And §13 forbids writing
 * adapter code before a vendor worksheet exists, so the second adapter is weeks
 * of research away — meaning the choice is between declaring the seam now and
 * discovering it later by refactoring the universal package into it under
 * deadline.
 *
 * The honest cost is stated rather than hidden: this contract is a prediction,
 * and the first real tax adapter will correct it. What it is **not** is a guess
 * at any vendor's format — every field here comes from §8's own list.
 *
 * ## Which functions are optional, and why that is the interesting part
 *
 * §8 qualifies four of its fourteen: `sendViaAPI()` *"when supported"*,
 * `generateManualImportInstructions()` *"when direct API is unavailable"*,
 * `parseImportErrors()` *"when supported"*. Those qualifications are the whole
 * design. A professional tax product's import path is often a file a human
 * carries into a desktop program, and an interface that made `sendViaAPI`
 * mandatory would force every such adapter to implement a lie.
 *
 * So they are optional members, and `capabilities` is what says which exist —
 * declared by the adapter rather than inferred by probing it for methods, so
 * that an adapter which *has* a `sendViaAPI` it is not yet licensed to use can
 * say so.
 */

import { RegistryError } from '@/modules/errors/registry'
import type { AccountantPackage } from './package'
import type { Assessment, PackageFacts } from './readiness'

/** A file an adapter produced, ready to be handed over. */
export type ExportFile = {
  /** File name as the firm receives it. */
  name: string
  content: string
  /** Rows of data, excluding any header. Zero for a manifest or instructions. */
  rowCount: number
}

/** What an adapter can and cannot do (§8 `getCapabilities`). */
export type AdapterCapabilities = {
  /** §8 `sendViaAPI` — whether this adapter can transmit rather than produce a file. */
  transmits: boolean
  /** §8 `parseImportErrors` — whether the target reports import errors machine-readably. */
  readsImportErrors: boolean
  /** §7 — whether the target can accept adjusting entries apart from balances. */
  acceptsJournalEntries: boolean
  /** §7 — whether supporting documents can be linked or transferred. */
  carriesDocuments: boolean
  /** The file extensions it produces. `[]` for an API-only adapter. */
  fileTypes: readonly string[]
}

export type ExportAdapter = {
  /** The `EXPORT_DESTINATIONS` key this adapter serves. */
  destinationKey: string
  /**
   * This adapter's own version (§6: independently versioned).
   *
   * Written into every export log row, so a file a vendor rejects six weeks
   * later is explicable. It moves when the output format moves, independently of
   * the application's version — that is the point of §6's sentence.
   */
  version: string
  /** §8 `getCapabilities`. */
  capabilities: AdapterCapabilities
  /**
   * §8 `getSupportedVersions` — which releases of the target this output suits.
   *
   * `null` means the question does not apply, which is true of exactly one
   * destination: the universal package is not a version of anybody's product.
   * For a real target `null` would be a worksheet that was never done.
   */
  supportedVersions: readonly string[] | null

  /**
   * §8's four `validate*` functions, folded into one.
   *
   * They are separate in §8 and separate here would be four functions whose
   * answers must be combined by every caller in the same way — which is how
   * three of them end up validated and the fourth forgotten. The readiness
   * registry holds the checks individually and `assess` combines them, so the
   * specification's granularity lives where it is useful: in the exception
   * report, which names the clause each exception came from.
   */
  assess: (facts: PackageFacts) => Assessment

  /**
   * §8 `mapAccounts`, `mapTaxCodes`, `mapEntityData`, `mapJournalEntries`,
   * `generateExportPackage` — the conversion, as one call.
   *
   * One function because §6's flow has one output: a normalized package goes in
   * and the target's files come out. Splitting the mapping out would only be
   * worth it if something other than `generateExportPackage` consumed a mapped
   * package, and nothing does.
   */
  generate: (pkg: AccountantPackage) => ExportFile[]

  /**
   * §8 `generateManualImportInstructions` *"when direct API is unavailable"*.
   *
   * Required on any adapter whose `capabilities.transmits` is false, which
   * `adapterStands` enforces: §15 requires *"a clear fallback file workflow
   * where no supported API exists"*, and an adapter that produces files with no
   * word on what to do with them has not provided one.
   */
  instructions?: (pkg: AccountantPackage) => string

  /** §8 `sendViaAPI` *"when supported"*. */
  sendViaApi?: (files: ExportFile[]) => Promise<{ reference: string }>

  /** §8 `parseImportErrors` *"when supported"*. */
  parseImportErrors?: (raw: string) => string[]
}

/**
 * Whether an adapter is coherent with what it claims.
 *
 * Not type-checkable, because every clause relates a declaration to a function's
 * presence: TypeScript can require `instructions?` and cannot require it *when
 * `transmits` is false*. Asserted in `tests/export-adapter.test.ts` over every
 * registered adapter.
 */
export function adapterStands(adapter: ExportAdapter): string[] {
  const faults: string[] = []

  if (adapter.capabilities.transmits && !adapter.sendViaApi) {
    faults.push(
      `${adapter.destinationKey} declares that it transmits and has no sendViaApi. ` +
        'An accountant would be offered a direct send that cannot happen.',
    )
  }
  if (!adapter.capabilities.transmits && adapter.sendViaApi) {
    faults.push(
      `${adapter.destinationKey} has a sendViaApi and declares that it does not transmit. ` +
        'If it is there because the vendor has not approved its use yet, say that in the ' +
        'destination entry — a capability declared false beside a working method is a trap.',
    )
  }
  if (!adapter.capabilities.transmits && !adapter.instructions) {
    faults.push(
      `${adapter.destinationKey} produces files and no import instructions. Spec §15 requires a ` +
        'clear fallback file workflow where no supported API exists, and a file with no word on ' +
        'what to do with it is not one.',
    )
  }
  if (adapter.capabilities.readsImportErrors && !adapter.parseImportErrors) {
    faults.push(
      `${adapter.destinationKey} declares that it reads import errors and has no parseImportErrors.`,
    )
  }
  if (!adapter.capabilities.readsImportErrors && adapter.parseImportErrors) {
    faults.push(
      `${adapter.destinationKey} has a parseImportErrors and declares that it cannot read import ` +
        'errors.',
    )
  }
  if (adapter.capabilities.fileTypes.length === 0 && !adapter.capabilities.transmits) {
    faults.push(
      `${adapter.destinationKey} produces no file types and does not transmit, so it has no way to ` +
        'deliver anything.',
    )
  }
  if (!/^\d+\.\d+$/.test(adapter.version)) {
    faults.push(
      `${adapter.destinationKey} has version "${adapter.version}", which is not a major.minor ` +
        'pair. Spec §6 requires adapters to be independently versioned and the export log records ' +
        'the string verbatim, so it has to be comparable by eye six weeks later.',
    )
  }

  return faults
}

/**
 * The adapters that exist.
 *
 * Registered rather than discovered, and a mutable registry rather than a
 * constant array, because `universal.ts` imports this module for the contract
 * and this module would otherwise import it back for the implementation.
 *
 * One entry today, and `adapterFor` says so when asked for any other — the same
 * refusal `mayExportTo` gives, from the other side of the seam.
 */
const ADAPTERS = new Map<string, ExportAdapter>()

export function registerAdapter(adapter: ExportAdapter): void {
  const faults = adapterStands(adapter)
  if (faults.length > 0) {
    // Thrown at import time on purpose: an incoherent adapter should stop the
    // process that loaded it rather than wait to be offered to somebody.
    throw new Error(`Adapter ${adapter.destinationKey} does not stand up:\n- ${faults.join('\n- ')}`)
  }
  ADAPTERS.set(adapter.destinationKey, adapter)
}

export function registeredAdapters(): ExportAdapter[] {
  return [...ADAPTERS.values()]
}

/** The adapter for a destination. Throws when none is written. */
export function adapterFor(destinationKey: string): ExportAdapter {
  const found = ADAPTERS.get(destinationKey)
  if (!found) {
    throw new RegistryError({
      registry: 'ADAPTERS',
      key: destinationKey,
      message:
        `No export adapter is registered for "${destinationKey}". Spec §13 is why: an adapter ` +
        'waits on a one-page integration worksheet citing the vendor’s own documentation, because ' +
        'professional tax and workpaper products import through vendor files, desktop bridges and ' +
        'partner programmes as often as through an API. The universal accountant package is the ' +
        'fallback §15 requires in the meantime.',
    })
  }
  return found
}
