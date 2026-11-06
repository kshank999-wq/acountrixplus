import type { ClientVersion } from '@/modules/crm/client-link'

/**
 * The version history on the client link (spec §7, Phase 189).
 *
 * §7's bullet asks the client-facing link for *"version history"*, and before
 * this the client saw one *Download the PDF* with no sign the document had ever
 * been revised. The company's own workspace has listed versions since Phase 21.
 *
 * ## What each row says, and why the rows differ
 *
 * A version the client opened carries its date, its total, and a link. One
 * they never opened carries its date and nothing else.
 *
 * The rule is `clientVersionHistory`'s and is argued there: a company that
 * sends a price by mistake and corrects it an hour later should not have this
 * page hand the client the mistake, on a link they may never have opened in
 * that hour. Knowing the document *was* revised is a different thing from
 * being told what it said, and only the first is owed.
 *
 * ## Nothing at all for a proposal sent once
 *
 * Which is most of them. "Version 1 of 1" on every proposal is noise, and
 * noise on a client-facing page is worse than noise anywhere else — it is the
 * one page where everything present is read.
 */
export function VersionHistory({
  token,
  versions,
}: {
  token: string
  versions: ClientVersion[]
}) {
  if (versions.length < 2) return null

  const formatted = (at: Date) =>
    at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <section className="doc-screen-only mx-auto mt-6 max-w-3xl px-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
        Earlier versions
      </h2>
      <p className="mt-1 text-xs text-faint">
        This proposal has been revised. You are reading the current version.
      </p>

      <ul className="mt-2 divide-y divide-line border-t border-line">
        {versions.map((version) => (
          <li
            key={version.versionNumber}
            className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-xs"
          >
            <span className={version.isCurrent ? 'font-medium' : 'text-muted'}>
              Version {version.versionNumber}
              {version.isCurrent && ' — the one above'}
            </span>

            <span className="flex items-center gap-3 text-muted">
              <span>{formatted(version.sentAt)}</span>

              {version.canDownload && !version.isCurrent && (
                /*
                  To the PDF route beside this page, not to the page itself: a
                  superseded version is a document somebody read, not a state
                  this page can be put into. Rendering an old version live
                  would need its blocks, which the snapshot has only carried
                  since Phase 188 — and a half-rendered old version is the
                  two-documents problem this whole arc is about.
                */
                <a
                  href={`/p/${token}/pdf?version=${version.versionNumber}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Download
                </a>
              )}

              {!version.canDownload && (
                <span className="text-faint" title="This version was replaced before you opened it">
                  not opened
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
