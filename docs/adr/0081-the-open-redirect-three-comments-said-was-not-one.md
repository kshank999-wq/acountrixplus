# 0081 — The open redirect three comments said was not one

**Status:** accepted
**Date:** Phase 81
**Amends:** ADR 0005 (marketing), ADR 0013 (sessions and MFA), ADR 0080 (style values).

## A correction to the nomination

ADR 0080 nominated this phase on the theory that `safeUrl`'s guarantee and what
reached an `href` after the tracking wrapper were two different questions. That
was wrong, and checking it first is the point: the wrapper encodes with
`encodeURIComponent`, the redirect route re-runs `safeUrl` on what comes back,
and both are documented. The round trip was fine.

The defect was one layer up, and larger.

## The defect

Every link in a campaign email is rewritten to `/api/track/:token?u=<url>` so a
click is recorded. `recordClick` put the destination through `safeUrl` before
following it — under three separate assurances that this closed an open
redirect:

> an attacker who forges a tracking link must not be able to turn it into an
> open redirect to a phishing page — `engagement.ts`

> a tracking link must never become an open redirect just because the token did
> not resolve — the route

> re-validates the click destination, so a forged link is not an open redirect
> — **the name of the test for it**

`safeUrl` confines a link to `http(s)` and `mailto`. That stops a `javascript:`
target, which is stored XSS — a real problem, and a different one. It says
nothing whatsoever about **which** https destination, and an open redirect is
entirely a question of which. `?u=https://phishing.test` satisfied all three.

The test is the clearest evidence. It asserted that `javascript:alert(1)` is
refused and `https://example.com/read` is accepted, and called that
open-redirect safety. Scheme safety was being read as destination safety, and
the name made the mistake durable — anyone checking whether this was covered
would have found a test that said yes.

**What it took to use.** A recipient token, which is in the URL of every link in
every campaign email that recipient received. So anybody on a company's mailing
list could mint a link beginning with that company's real domain and ending
anywhere — the shape phishing uses to borrow a brand's credibility.

## Decision 1: the destination is signed when the link is built

`modules/marketing/click-links` mints an HMAC over the destination at send and
verifies it at click. A URL nobody sent is a URL nobody signed.

Stateless, so no lookup joins the click path, and exact — a destination
carrying merge fields resolved per recipient still verifies, because it is
signed after resolution, as the thing actually put in the letter. The
alternative considered was checking the destination against the campaign
creative's own links; it needs the per-recipient merge resolution repeated at
click time to compare, which is more code and more ways to be wrong.

**The cost, stated plainly:** a link in an email already delivered carries no
signature and now lands on the home page rather than its destination. That is
the same treatment as a forged link, and it is the smaller cost — the
alternative is leaving a live open redirect. A deployment with real campaigns
already in inboxes would want a grace window instead; this application has none.

## Decision 2: one answer to what this application signs with

`auth/session`, `auth/challenge` and `auth/secret-box` each read a secret from
the environment, refuse in production when it is missing, and fall back to a
fixed development value. `secret-box`'s own comment says *"Same shape as
`SESSION_SECRET` in `session.ts`."* Phase 81 needed a fourth. Writing it would
have been the defect this codebase keeps removing.

`lib/signing` names the shape once. Two details are deliberate:

- **`challenge`'s instinct becomes the rule.** It signed with
  `${secret}:mfa-challenge` rather than the bare secret, so a signature minted
  for one purpose cannot be replayed as another. `signingSecret(purpose)` does
  that for everything; the derived value is byte-for-byte what it was.
- **The session cookie keeps the bare secret.** It signed that way before this
  phase, and adding a suffix would invalidate every cookie currently in a
  browser. A refactor is not a logout.

`secret-box` is left alone. It reads `ENCRYPTION_KEY`, not `SESSION_SECRET`,
because an encryption key and a signing key should not be the same value — that
is a different secret with the same shape, and merging them would be merging two
things that only look alike.

## Decision 3: `safeUrl` returns something that is a URL

`BARE_DOMAIN`'s tail is `.*`, so `evil.com/x" onmouseover=` matched it and came
back as `https://evil.com/x" onmouseover=` — prefixed rather than refused, and
not a URL.

Not exploitable: React escapes the attribute on the document page and
`escapeHtml` does on the email side. But a function whose job is to return a
safe link target should not return something that is not a link, and Phase 80
was about exactly this — a promise wider than the guarantee kept. It now
normalises through the URL parser, so the quote comes back as `%22` whatever the
sink does with it, and anything the parser cannot make sense of is refused
rather than repaired.

The signature is minted over the output of `safeUrl` and `recordClick` runs
`safeUrl` again on what arrives, so the two agree only because it is idempotent.
That is asserted rather than assumed.

## What this did not do

No schema change, no migration. Nothing stored moves.

The tracking token is still the recipient's unsubscribe token. One token doing
two jobs is worth a look — an unsubscribe link is meant to be usable by anyone
holding it, and a tracking token now gates nothing else, so the sharing is
defensible rather than accidental. It is not examined here.

## What the next phase might take

The open handed to a pixel is the same route and got none of this attention:
`recordOpen` takes a token and nothing else, and its failure is swallowed on
purpose so a broken analytic never breaks a rendered email. That swallow is
right. What is not obviously right is that anyone holding a recipient token can
mark that recipient as having opened an email they never opened, as many times
as they like — engagement figures a salesperson acts on, and, through
`createFollowUpTask` on the click path, work that appears in somebody's queue.
Whether that matters is a product question worth asking out loud rather than a
defect to assume.
