import { sendTransactional } from './service'

/**
 * The letter warning somebody their password is being guessed (Phase 100).
 *
 * Lives here rather than in `guard-service.ts` so the auth modules do not
 * import the notify layer — which imports `users` and would close a circle.
 * `guardAct` takes this as a parameter instead, which also means a test can
 * watch what it would have sent without a mailer.
 *
 * `security_alert` rather than a kind of its own: it is the same event
 * `email-change` reports when somebody moves a sign-in address, and Phase 98
 * decided that shape then. It carries no `action`, so it can carry no link.
 */
export async function sendGuardWarning(letter: {
  to: string
  toName: string
  subject: string
  body: string[]
}): Promise<unknown> {
  return sendTransactional({
    to: letter.to,
    toName: letter.toName,
    // A pre-authentication-shaped act with no tenant of its own; the same
    // null a reset carries, for the same reason.
    companyId: null,
    kind: 'security_alert',
    subject: letter.subject,
    body: letter.body,
  })
}
