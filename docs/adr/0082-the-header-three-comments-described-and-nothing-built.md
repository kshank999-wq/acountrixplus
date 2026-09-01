# 0082 — The header three comments described and nothing built

**Status:** accepted
**Date:** Phase 82
**Amends:** ADR 0005 (marketing), ADR 0019 (the transactional channel).

## A nomination that mostly did not survive

ADR 0081 nominated the tracking pixel: anyone holding a recipient token can
mark that recipient as having opened an email they never opened. Checking it
first found three things already right, and they are worth recording because
the absence of a defect is also a finding.

- **The reported "opened" figure is already unique per recipient.** `campaignStats`
  counts recipients whose `openedAt` is set, not `campaign_events` rows, so a
  mail client rendering an email three times does not inflate it.
- **The events are not unbounded.** `campaign_events` is one of the named
  retention policies from Phase 24 and is swept nightly.
- **The unsubscribe page does not act on GET.** It renders a confirm button and
  the change is a POST, with a comment saying exactly why — scanners and
  pre-fetchers follow links.

What remains of the nomination is real but small and inherent to the medium: a
pixel URL is a GET anybody can replay, and no amount of code changes that. It is
in the README's caveats rather than fixed here.

Looking one layer out found the actual defect.

## The defect

`OutboundMessage` has carried `unsubscribeUrl` and `unsubscribePostUrl` since
Phase 5, and three places say what they are for:

> Sent as the `List-Unsubscribe` header too, which is what mail clients surface
> as their own unsubscribe button — and what keeps a sender out of the spam
> folder. — the field's own doc

> Every message is kept so a test can assert exactly what would have gone out —
> **including the unsubscribe header**. — `MockEmailProvider`

> This is also the target of the `List-Unsubscribe` header, and RFC 8058
> specifies exactly this. — the POST route

**No code anywhere built a header from either field.** Two strings on a type,
described as headers by prose, and the only adapter in the tree pushes the
message onto an array. The same shape as Phases 79, 80 and 81: a promise stated
in a comment and kept by nothing.

It is the promise that decides whether the mail arrives. Gmail and Yahoo have
required one-click unsubscribe from bulk senders since February 2024; a campaign
without these headers is **filtered rather than refused**, so the sending company
watches its delivery rate fall with nothing anywhere saying why.

## And the two field docs disagree

Worth more than the missing header, because it would have survived writing one.

`unsubscribeUrl`'s doc said it is sent as `List-Unsubscribe`. It must not be.
RFC 8058 has the mail client **POST** to the URI in that header, and
`unsubscribeUrl` is `/u/:token` — the confirmation page, whose whole purpose,
stated in its own comment, is that it does not change state without somebody
pressing a button. A client posting there would unsubscribe nobody, and the
reader who pressed their mail client's own button would stay subscribed
believing they had left.

`unsubscribePostUrl`'s doc has it right: "it must be the endpoint rather than
the confirmation page." Two comments in the same type, one field apart,
disagreeing about which URL goes in the header — and whichever adapter got
written first would have picked one.

## Decision 1: the pipeline builds the headers, the adapter carries them

`modules/marketing/list-headers` builds them; `sendStep` attaches them; the
message carries `headers` as a **required** field so a second construction site
cannot ship without them and typecheck.

Built in the pipeline rather than in an adapter on purpose. An adapter that has
to rediscover RFC 8058 is an adapter that will ship without it, and this
application has no real ESP adapter yet — so the person who writes one is
exactly the person this decision protects. They pass `headers` through verbatim.

## Decision 2: it throws rather than omitting

`listUnsubscribeHeaders` refuses a URL that cannot go in a header — cleartext
off localhost, or anything containing `<`, `>`, a comma or a newline, which
would split the header outright.

Throwing is the deliberate choice. A bulk send that quietly loses its
unsubscribe header is the exact failure this module exists to prevent, and it is
invisible from the sending end: the mail is filtered, not bounced, so nothing
comes back to say so. Better to refuse to send.

Localhost over http is allowed, because `publicBaseUrl()` is
`http://localhost:3000` until `PUBLIC_BASE_URL` is set. A rule that made the
seed and the whole test suite throw would be a rule about development rather
than about email.

## What this did not do

No schema change and no migration. Nothing stored moves.

The transactional channel is untouched and must stay that way. A
`TransactionalMessage` has neither field to put an unsubscribe link in, which
ADR 0019 chose deliberately: an unsubscribe link on a password reset is an offer
to stop sending somebody the only mail that can let them back in. The test
asserts that channel has none of this.

The one-click endpoint does not check that the POST body says
`List-Unsubscribe=One-Click`. RFC 8058 permits the check and does not require
it, and a body a client formats slightly differently should still unsubscribe
the person who asked — the cost of being wrong in that direction is somebody
staying on a list they pressed a button to leave.

## What the next phase might take

Every finding from Phase 79 to here has been in the same seam: a comment
asserting a property the code does not have. Four phases is enough to suspect a
pattern rather than four coincidences, and the cheapest next move may not be
another instance but a way to find them — the assertions that survived were all
of the form *read the source and check the claim*, and this codebase now has
eight or nine of those scattered across five test files with no name.

Failing that, `email-provider`'s `tags` field is the same shape one field over:
documented as correlating "a provider callback back to a recipient row", set by
`sendStep`, and read by nothing, because there is no callback handler. A bounce
or complaint webhook is what would read it, and the suppression list it should
feed is the thing that keeps a sender out of the spam folder once the headers
have got them into the inbox.
