/**
 * Where an artifact came from, and what must be said about it (Phase 165).
 *
 * ADR 0164's audit found two of §11's seven AI capabilities missing and
 * nominated **AI Design Assistant** first, with a specific reason: §11 asks it
 * to *"generate layout suggestions, brand-consistent variations,
 * background/graphic concepts, image prompts, and logo ideation; preserve user
 * control and provenance"* — and provenance is a data decision that should be
 * settled before a prompt is written.
 *
 * ## What measuring found
 *
 * **User control already exists and is well made.** `ai_suggestions` carries an
 * accept/reject decision with a rule worth repeating:
 *
 * > the *person* who accepted, not the model, because the person is who decided
 *
 * and a suggestion is never marked accepted until the ordinary service has
 * actually performed the action. §12's human-in-the-loop requirement is met.
 *
 * **Provenance does not exist at all**, and `ai_requests` is not it.
 * `ai_requests` is §12's *usage ledger* — tenant, user, feature, provider,
 * model, tokens, cost, latency, outcome. It records that a request happened and
 * what it cost. It does not record what was produced, or where what was produced
 * ended up.
 *
 * Those are different questions, and conflating them is how a product ends up
 * able to bill for a generated image and unable to say which client proposal it
 * is sitting in.
 *
 * ## The two findings that shape this
 *
 * **1. `assets.uploadedBy` encodes an assumption that is about to become
 * false.** Every asset today was uploaded by a person, so a nullable
 * `uploaded_by` and no provenance field together say "a person put this here".
 * The first asset a Design Assistant produces makes that a false declaration on
 * every row that carries it — this project's oldest defect (Phases 110, 125), in
 * the table whose contents get emailed to clients.
 *
 * **2. Provenance that does not propagate is true once and false forever
 * after.** §11 asks for *"brand-consistent variations"*. A variation of an
 * AI-generated background is itself AI-derived; a flyer built from it contains
 * AI-generated material; the proposal PDF that embeds the flyer reaches a
 * client. Today `assets` has no derivation relationship at all — nothing is
 * `derivedFrom` anything — so the moment the assistant exists, the chain it
 * creates has nowhere to be recorded.
 *
 * The chain that matters, measured: `assets` → a block's `assetId` →
 * `design_documents` → the rendered proposal → a client.
 *
 * ## Disclosure, not credit
 *
 * The lattice below deliberately does **not** rank who did the most work. A
 * person who heavily edits an AI-generated image has done most of the work and
 * the result still contains AI-generated material, which is the thing a client,
 * a regulator or a stock-image licence cares about.
 *
 * So `strongerOf` answers *what must be disclosed*, and derivation takes the
 * join rather than the parent's or the child's value alone. An artifact is as
 * disclosable as the most disclosable thing it is made of.
 */

import { RegistryError } from '@/modules/errors/registry'

/** How an artifact came to exist. */
export type ProvenanceOrigin =
  /** A person supplied the file. The assumption every existing asset row makes. */
  | 'uploaded'
  /** A person made it in the application — the design editor, the studio. */
  | 'authored'
  /**
   * A person made it with a model's help: an accepted layout suggestion, a
   * palette the assistant proposed, a caption it drafted.
   *
   * Distinct from `ai-generated` because the human choice is load-bearing — and
   * distinct from `authored` because a client asking "did a machine write this"
   * deserves yes.
   */
  | 'ai-assisted'
  /** A model produced it whole: a generated background, a logo concept. */
  | 'ai-generated'

export type OriginDefinition = {
  origin: ProvenanceOrigin
  /** Whether a model was involved, which decides whether an `aiRequestId` is required. */
  machineInvolved: boolean
  /** What a client, a licence audit or a regulator would need told. */
  disclosure: string | null
  because: string
}

/**
 * The four origins, each arguing for itself (Phase 101's device).
 *
 * Ordered weakest to strongest *for disclosure*, which is the order
 * `strongerOf` joins on and is deliberately not an order of effort.
 */
export const PROVENANCE_ORIGINS: readonly OriginDefinition[] = [
  {
    origin: 'uploaded',
    machineInvolved: false,
    disclosure: null,
    because:
      'A person supplied the file. Nothing to disclose, and it is the assumption every existing ' +
      '`assets` row already makes through `uploaded_by` — which is why the backfill can assert it ' +
      'rather than guess.',
  },
  {
    origin: 'authored',
    machineInvolved: false,
    disclosure: null,
    because:
      'A person made it here. Separate from `uploaded` because the two answer different questions ' +
      'later — a licensing audit cares which files came from outside, and nothing else records ' +
      'that once an asset is a row.',
  },
  {
    origin: 'ai-assisted',
    machineInvolved: true,
    disclosure: 'Parts of this were produced with AI assistance.',
    because:
      'A person decided and a model helped. The human choice is load-bearing, which is what ' +
      'separates it from `ai-generated`, and a model was still involved, which is what separates ' +
      'it from `authored`. `ai_suggestions` already records the accept/reject that produces this ' +
      'origin; this is where that decision lands on the artifact rather than on the decision.',
  },
  {
    origin: 'ai-generated',
    machineInvolved: true,
    disclosure: 'This was generated by AI.',
    because:
      'A model produced it whole. The strongest disclosure, and the one that must survive every ' +
      'subsequent edit — see `strongerOf`.',
  },
]

/** The definition an origin names. Throws on one nobody declared. */
export function originFor(origin: string): OriginDefinition {
  const found = PROVENANCE_ORIGINS.find((row) => row.origin === origin)
  if (!found) {
    throw new RegistryError({
      registry: 'PROVENANCE_ORIGINS',
      key: origin,
      message:
        `No provenance origin is declared as "${origin}". The list is what an artifact can say ` +
        'about where it came from, and each entry carries what has to be disclosed because of it ' +
        '— so a new one is an entry there with its disclosure, not a free-text value on a row.',
    })
  }
  return found
}

/** Rank for disclosure. Not a rank of effort, and not a rank of quality. */
function rank(origin: ProvenanceOrigin): number {
  return PROVENANCE_ORIGINS.findIndex((row) => row.origin === origin)
}

/**
 * The origin that must be disclosed when two meet.
 *
 * **The rule the whole module exists for.** An artifact is as disclosable as the
 * most disclosable thing it is made of, so derivation takes the join and never
 * the child's own value alone.
 *
 * A person cropping an AI-generated background has authored a crop of
 * AI-generated material. `authored` would be true about what they did and false
 * about what the file contains, and the file is what reaches the client.
 */
export function strongerOf(a: ProvenanceOrigin, b: ProvenanceOrigin): ProvenanceOrigin {
  return rank(a) >= rank(b) ? a : b
}

export type Provenance = {
  origin: ProvenanceOrigin
  /**
   * The `ai_requests` row behind it, when a model was involved.
   *
   * Required for a machine origin and forbidden for a human one, enforced by a
   * CHECK rather than by remembering — because an artifact claiming to be
   * AI-generated with no request behind it is a declaration argued from a fact
   * that is not a fact, and one claiming to be human-made while carrying a
   * request id is the same error in the dangerous direction.
   */
  aiRequestId: string | null
  /** What it was made from, if anything. */
  derivedFromId: string | null
}

/** Whether a provenance record is internally coherent. */
export function provenanceStands(provenance: Provenance): string[] {
  const faults: string[] = []
  const definition = originFor(provenance.origin)

  if (definition.machineInvolved && !provenance.aiRequestId) {
    faults.push(
      `${provenance.origin} claims a model was involved and names no AI request. The usage ledger ` +
        'is what makes the claim checkable; without it the origin is an assertion about something ' +
        'nothing recorded.',
    )
  }
  if (!definition.machineInvolved && provenance.aiRequestId) {
    faults.push(
      `${provenance.origin} says no model was involved and carries an AI request. That is the same ` +
        'error in the direction that matters: it would let AI-generated material be disclosed as ' +
        'human-made.',
    )
  }

  return faults
}

/**
 * The provenance of something made from something else.
 *
 * Takes the join, so the parent's disclosure survives the child's edit.
 */
export function derivedProvenance(
  parent: { origin: ProvenanceOrigin; id: string },
  own: Provenance,
): Provenance {
  return {
    origin: strongerOf(parent.origin, own.origin),
    aiRequestId: own.aiRequestId,
    derivedFromId: parent.id,
  }
}

/**
 * What has to be said about an artifact, or `null` when nothing does.
 *
 * One sentence, because it has to fit on a proposal footer and in an export
 * manifest, and because a paragraph would be read as a disclaimer rather than
 * as a fact.
 */
export function disclosureFor(origin: ProvenanceOrigin): string | null {
  return originFor(origin).disclosure
}

/**
 * The disclosure for a whole document, given everything in it.
 *
 * The chain this exists for, measured in Phase 165: `assets` → a block's
 * `assetId` → `design_documents` → the rendered proposal → a client. A document
 * discloses the strongest provenance of anything it embeds, which is why this
 * takes a list rather than a value.
 */
export function documentDisclosure(origins: readonly ProvenanceOrigin[]): string | null {
  if (origins.length === 0) return null
  return disclosureFor(origins.reduce(strongerOf))
}
