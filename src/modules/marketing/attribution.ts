import {
  BOUNCE_WATCH_BP,
  COMPLAINT_WATCH_BP,
  sendingHealth,
  type SendingCounts,
} from './reputation'

/**
 * Which send put the domain in trouble (Phase 85).
 *
 * ## The culprit the digest could not name
 *
 * Phase 84 watches a company's bounce and complaint rates and tells somebody
 * when they cross the line mailbox providers care about. The verdict it gives
 * is **company-wide**, and the cause is almost never company-wide: one
 * badly-sourced list, one import from a conference badge scanner, one campaign
 * to a segment nobody had mailed in three years. The digest says the domain is
 * in trouble and leaves the reader to work out which send did it — from a
 * per-campaign bounce rate that has existed since Phase 5 and that nobody has
 * a reason to open until they already know something is wrong.
 *
 * ## The judgement: a culprit is a counterfactual, not a maximum
 *
 * The obvious implementation is "name the campaign with the worst rate". It is
 * wrong, and wrong in the way that matters: the worst rate in any window will
 * usually belong to the *smallest* campaign in it. Three bounces out of eight
 * is a 37% bounce rate and moves a company sending four thousand messages a
 * week by four hundredths of a per cent. Naming it sends somebody to audit a
 * list that is not the problem, and the real cause keeps sending.
 *
 * So the question this asks is the one a person actually has: **would we still
 * be over the line if this campaign had not gone out?** Rank by how much
 * removing a campaign improves the company's rate, and the materiality test
 * comes for free — a campaign too small to matter cannot move the number, so it
 * is never named. No arbitrary volume floor is needed here, which is why there
 * is not one.
 *
 * `explainsIt` then says whether the counterfactual actually clears it. A
 * campaign can be the largest single contributor and still not be the whole
 * story, and telling somebody to stop one send when the list is broadly rotten
 * would be worse than telling them nothing.
 *
 * ## When there is no culprit
 *
 * A uniformly bad list has no culprit, and the biggest campaign in it is the
 * biggest campaign rather than the cause. Saying a name is a claim; there has
 * to be an answer that declines to make one.
 *
 * Being worse than the company's own rate is not enough of a bar on its own —
 * a browser check found that out. Two equally bad campaigns plus a little
 * clean traffic makes *both* of them worse than the average they are pulling
 * up, so one always gets named, and removing it would move the rate from 11.9%
 * to 11.8%. Naming a campaign says *stop this and it gets better*, so the
 * counterfactual has to be worth acting on: removing it must move a rate by at
 * least one watch threshold's worth — two points of bounces, or a tenth of a
 * point of complaints, or a mix of the two.
 *
 * Nothing here touches the database or the clock.
 */

/** One campaign's share of a window, in the same terms as the company's. */
export type CampaignSending = {
  campaignId: string
  name: string
  /** Everything a provider accepted for this campaign, bounces included. */
  accepted: number
  bounced: number
  complained: number
}

export type Culprit = {
  campaignId: string
  name: string
  accepted: number
  bounceRateBp: number
  complaintRateBp: number
  /** What the company's rates would be had this campaign not gone out. */
  withoutItBounceRateBp: number
  withoutItComplaintRateBp: number
  /**
   * Whether removing it brings the company back under both watch thresholds.
   *
   * False means it is the largest single contributor and still not the whole
   * story — worth looking at, not worth believing you have found the problem.
   */
  explainsIt: boolean
}

/**
 * How much a campaign has to matter before it gets named.
 *
 * One, in units of watch thresholds: removing the campaign must take two
 * percentage points off the bounce rate, or a tenth of a point off the
 * complaint rate, or some combination. Below that, "stop this one" is advice
 * that would not have helped.
 */
const MATERIAL_IMPROVEMENT = 1

function rateBp(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 10_000)
}

/** The company's counts with one campaign's contribution taken back out. */
function without(counts: SendingCounts, campaign: CampaignSending): SendingCounts {
  return {
    accepted: Math.max(0, counts.accepted - campaign.accepted),
    bounced: Math.max(0, counts.bounced - campaign.bounced),
    complained: Math.max(0, counts.complained - campaign.complained),
  }
}

/**
 * The campaign most responsible for a company being over the line, if one is.
 *
 * Returns `null` when there is nothing to attribute — the company is fine, or
 * has not sent enough for a verdict — and when no single campaign is worse than
 * the company's own rate.
 */
export function worstOffender(
  counts: SendingCounts,
  campaigns: readonly CampaignSending[],
): Culprit | null {
  const verdict = sendingHealth(counts)
  if (verdict === null || verdict.level === 'ok') return null

  const companyBounceBp = rateBp(counts.bounced, counts.accepted)
  const companyComplaintBp = rateBp(counts.complained, counts.accepted)

  let best: Culprit | null = null
  let bestImprovement = MATERIAL_IMPROVEMENT

  for (const campaign of campaigns) {
    if (campaign.accepted <= 0) continue

    const bounceBp = rateBp(campaign.bounced, campaign.accepted)
    const complaintBp = rateBp(campaign.complained, campaign.accepted)

    // A campaign at or below the company's own rate is being carried by the
    // rest, not carrying it. Removing it would make the number worse.
    if (bounceBp <= companyBounceBp && complaintBp <= companyComplaintBp) continue

    const rest = without(counts, campaign)
    const restBounceBp = rateBp(rest.bounced, rest.accepted)
    const restComplaintBp = rateBp(rest.complained, rest.accepted)

    /*
      How much of the problem this campaign is, measured against the thresholds
      rather than in raw basis points. A tenth of a per cent of complaints and a
      tenth of a per cent of bounces are not the same size of problem, and
      ranking on the raw numbers would let a small bounce movement outvote a
      large complaint one every time.
    */
    const improvement =
      (companyBounceBp - restBounceBp) / BOUNCE_WATCH_BP +
      (companyComplaintBp - restComplaintBp) / COMPLAINT_WATCH_BP

    // Also the materiality bar, since `bestImprovement` starts there rather
    // than at zero: a campaign whose removal changes nothing is not a cause.
    if (improvement < bestImprovement) continue

    bestImprovement = improvement
    best = {
      campaignId: campaign.campaignId,
      name: campaign.name,
      accepted: campaign.accepted,
      bounceRateBp: bounceBp,
      complaintRateBp: complaintBp,
      withoutItBounceRateBp: restBounceBp,
      withoutItComplaintRateBp: restComplaintBp,
      explainsIt:
        restBounceBp < BOUNCE_WATCH_BP && restComplaintBp < COMPLAINT_WATCH_BP,
    }
  }

  return best
}

/**
 * What to say about a culprit, or null when there is nothing to add.
 *
 * A phrase rather than a code, matching `SendingHealth.concern`: the consumers
 * are a digest somebody reads on a phone and a line on a page, and both want a
 * sentence they can act on without a legend.
 */
export function culpritPhrase(culprit: Culprit | null): string | null {
  if (culprit === null) return null

  const worst =
    culprit.complaintRateBp / COMPLAINT_WATCH_BP > culprit.bounceRateBp / BOUNCE_WATCH_BP
      ? `${(culprit.complaintRateBp / 100).toFixed(1)}% marked it as spam`
      : `${(culprit.bounceRateBp / 100).toFixed(1)}% of it bounced`

  return culprit.explainsIt
    ? `Mostly "${culprit.name}" — ${worst}, and without it the rest is fine`
    : `Worst is "${culprit.name}" — ${worst}, though it is not the whole story`
}
