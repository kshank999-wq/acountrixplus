import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell } from '@/components/app-shell'
import {
  getProfile,
  listBrandKits,
  listClauses,
  listServiceItems,
} from '@/modules/studio/service'
import { listAssets } from '@/modules/studio/assets'
import { listTeamMembers } from '@/modules/studio/team'
import { categorizableAccounts } from '@/modules/coa/service'
import { StudioWorkspace } from './studio-workspace'

export const dynamic = 'force-dynamic'

/** The Design Center — "Company Studio" in spec §15. */
export default async function StudioPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'crm:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Design Center</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the Design Center.
        </p>
      </main>
    )
  }

  const [profile, kits, assets, services, clauses, team, accounts] = await Promise.all([
    getProfile(actor),
    listBrandKits(actor),
    listAssets(actor),
    listServiceItems(actor),
    // Retired clauses included, for the same reason as the people below: this
    // is the one screen that can restore one, and the two designers that
    // *offer* clauses get the default, which is live ones only (Phase 205).
    listClauses(actor, { includeRetired: true }),
    // Retired people included: this is the one screen that can restore them,
    // and a directory that hid them would make retiring look like a delete.
    listTeamMembers(actor, { includeRetired: true }),
    can(actor, 'bookkeeping:view') ? categorizableAccounts(actor) : Promise.resolve([]),
  ])

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="studio"
    >
      <StudioWorkspace
        canManage={can(actor, 'company:manage')}
        profile={
          profile
            ? {
                legalName: profile.legalName ?? '',
                dba: profile.dba ?? '',
                tagline: profile.tagline ?? '',
                addressLine1: profile.addressLine1 ?? '',
                city: profile.city ?? '',
                region: profile.region ?? '',
                postalCode: profile.postalCode ?? '',
                phone: profile.phone ?? '',
                email: profile.email ?? '',
                website: profile.website ?? '',
                taxId: profile.taxId ?? '',
                paymentInstructions: profile.paymentInstructions ?? '',
                documentFooter: profile.documentFooter ?? '',
              }
            : null
        }
        kits={kits.map((kit) => ({
          id: kit.id,
          name: kit.name,
          isDefault: kit.isDefault,
          primaryColor: kit.primaryColor,
          accentColor: kit.accentColor,
          textColor: kit.textColor,
          mutedColor: kit.mutedColor,
          surfaceColor: kit.surfaceColor,
          headingFont: kit.headingFont,
          bodyFont: kit.bodyFont,
          baseSizePt: kit.baseSizePt,
          logoAssetId: kit.logoAssetId,
        }))}
        assets={assets.map((asset) => ({
          id: asset.id,
          filename: asset.filename,
          kind: asset.kind,
          sizeBytes: asset.sizeBytes,
        }))}
        services={services.map((item) => ({
          id: item.id,
          name: item.name,
          code: item.code,
          unit: item.unit,
          unitPriceCents: item.unitPriceCents,
          description: item.description,
        }))}
        clauses={clauses.map((clause) => ({
          id: clause.id,
          title: clause.title,
          category: clause.category,
          body: clause.body ?? '',
          versionNumber: clause.versionNumber ?? 1,
          approved: Boolean(clause.approvedAt),
          // Phase 205. Selected by `listClauses` from the start and dropped
          // here, which is the same shape as Phase 204's access board losing
          // `isActive` on the way to the screen — moot while nothing could set
          // it, wrong the moment something could.
          isActive: clause.isActive,
        }))}
        team={team.map((member) => ({
          id: member.id,
          name: member.name,
          title: member.title,
          bio: member.bio,
          qualifications: member.qualifications,
          email: member.email,
          phone: member.phone,
          isActive: member.isActive,
        }))}
        revenueAccounts={accounts
          .filter((account) => account.type === 'revenue')
          .map((account) => ({
            id: account.id,
            number: account.number,
            name: account.name,
          }))}
      />
    </AppShell>
  )
}
