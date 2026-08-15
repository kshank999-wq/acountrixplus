/**
 * Wording for security concepts, importable by client components.
 *
 * The same seam as `jobs/vocabulary.ts` and `payroll/vocabulary.ts`, for the
 * same reason: `login-history.ts` imports the database, and a client component
 * that imports a label from it drags the whole database client into the
 * browser bundle. Next fails that build, which is the good outcome — the bad
 * one would be shipping it.
 */

export const LOGIN_OUTCOME_LABELS: Record<string, string> = {
  success: 'Signed in',
  unknown_email: 'No such account',
  wrong_password: 'Wrong password',
  mfa_required: 'Password accepted, second factor not given',
  wrong_mfa_code: 'Wrong authentication code',
  reused_mfa_code: 'Authentication code already used',
  locked_out: 'Blocked — too many attempts',
  no_membership: 'Account belongs to no company',
}
