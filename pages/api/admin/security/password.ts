import type { NextApiRequest } from 'next'
import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext, requestOrigin } from '../../../../lib/auth'
import { rateLimit, rateLimitNetwork } from '../../../../lib/rateLimit'
import { log } from '../../../../lib/log'
import { changePassword, parseChangePasswordBody } from '../../../../lib/adminAuth/password'
import { requireRecentAuth, stepUpMethods } from '../../../../lib/adminAuth/stepUp'
import { recordAuthEvent } from '../../../../lib/adminAuth/store'
import { moveCreatedSession, revokeGrants } from '../../../../lib/ai/access'
import { voidOpenChanges } from '../../../../lib/ai/changes'

/**
 * POST /api/admin/security/password
 *   { currentPassword, newPassword, signOutOthers? = true, endAiApps? = true }
 *   → 200 { ok, changedAt, signedOutOthers, revoked, signedIn, bootstrap, aiAppsEnded, aiAppsError }
 *   → 400 PASSWORD_POLICY { error, issues }   the new password breaks a rule
 *   → 401 CURRENT_PASSWORD_INCORRECT          (NO_SESSION: not signed in;
 *                                             SIGNED_OUT: too many wrong current
 *                                             passwords — this session was ended)
 *   → 403 STEP_UP_REQUIRED                    "Require a passkey" is on and this
 *                                             browser has not verified recently
 *   → 409 PASSWORD_CHANGED_ELSEWHERE · 429 THROTTLED (Retry-After)
 *
 * Admin session required; the proxy refuses cross-site and non-JSON writes
 * (lib/security/csrf.ts) before this runs. 10 attempts per 15 minutes per
 * client and 30 per IPv6 /48, on top of the sign-in lockout the
 * current-password check shares, a per-session limit of wrong current
 * passwords (the session is signed out) and a site-wide cap on checks
 * (lib/adminAuth/password.ts has the whole sequence).
 *
 * Step-up: the current password IS the re-authentication, so with the
 * password allowed to sign in nothing else is asked (no double prompt). With
 * "Require a passkey" on, the password alone proves nothing anywhere in the
 * admin, so the change also needs a recent verification — a passkey, or the
 * password plus a recovery code — like every other dangerous action
 * (lib/adminAuth/stepUp.ts; the Security page asks first with
 * fetchWithStepUp).
 *
 * Connected AI apps (design §5.4): signing the other browsers out moves the
 * session version, which ends every app, and they are revoked outright too;
 * keeping the other browsers ends every app unless `endAiApps: false`. Apps
 * kept stay tied to this browser through its re-issued session, so signing
 * it out from another browser later still ends them.
 *
 * The password is changed first and stays changed whatever happens to the
 * apps. `aiAppsError: true` says revoking them failed while the others were
 * kept, so they may still reach the site (the Password card warns and links
 * to Connections). With the others signed out it is never set: the session
 * version moved, so no app can act whether or not the revoke went through.
 */

/** End every AI app after a password change and withdraw what they had waiting. */
function endAiApps(req: NextApiRequest, sessionId: string | null): { ended: number; failed: boolean } {
  let ended: string[]
  try {
    ended = revokeGrants({ all: true }, 'ended by a password change')
  } catch (err) {
    log.error('AI apps could not be ended with the password change', { err })
    return { ended: 0, failed: true }
  }
  if (!ended.length) return { ended: 0, failed: false }
  try {
    voidOpenChanges({ actorIds: ended }, 'ISSUER_ENDED')
  } catch (err) {
    log.error('AI changes of ended apps could not be withdrawn', { err })
  }
  try {
    recordAuthEvent({ type: 'ai-apps-ended', sessionId, detail: `${ended.length} ended by a password change`, ...requestOrigin(req) })
  } catch (err) {
    // The apps ended all the same; only the history line is missing.
    log.error('Ended AI apps could not be noted in the sign-in history', { err })
  }
  return { ended: ended.length, failed: false }
}

export default withApi('admin/security/password', async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  res.setHeader('Cache-Control', 'no-store')
  let ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })

  const hits = [
    rateLimit(req, 10, 15 * 60_000, 'admin:password-change'),
    // One IPv6 allocation must not multiply its budget across its /64s.
    rateLimitNetwork(req, 30, 15 * 60_000, 'admin:password-change:net48'),
  ]
  res.setHeader('X-RateLimit-Remaining', String(Math.min(...hits.map((h) => h.remaining))))
  const refused = hits.filter((h) => !h.allowed)
  if (refused.length) {
    const resetAt = Math.max(...refused.map((h) => h.resetAt))
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
    res.setHeader('Retry-After', String(retryAfterSeconds))
    return res
      .status(429)
      .json({ code: 'THROTTLED', error: 'Too many attempts. Try again later.', retryAfterSeconds })
  }

  const input = parseChangePasswordBody(req.body)
  if (!input)
    return res
      .status(400)
      .json({
        code: 'INVALID_INPUT',
        error: 'Send { currentPassword, newPassword, signOutOthers }.',
      })

  if (stepUpMethods().recoveryRequired) {
    ctx = requireRecentAuth(req, res)
    if (!ctx) return
  }

  const result = await changePassword(req, res, ctx, input)
  if (result.status === 429) res.setHeader('Retry-After', String(result.body.retryAfterSeconds))
  if (result.status !== 200) return res.status(result.status).json(result.body)
  const sessionId = result.renewed?.to ?? ctx.session?.id ?? null
  let apps = { ended: 0, failed: false }
  if (input.signOutOthers || input.endAiApps) apps = endAiApps(req, sessionId)
  else if (result.renewed) {
    try {
      moveCreatedSession(result.renewed.from, result.renewed.to)
    } catch (err) {
      log.error('AI apps could not follow the re-issued session', { err })
    }
  }
  return res.status(200).json({ ...result.body, aiAppsEnded: apps.ended, aiAppsError: apps.failed && !input.signOutOthers })
})
