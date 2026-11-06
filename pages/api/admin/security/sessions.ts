import type { NextApiRequest } from 'next'
import { bumpSessionVersion } from '../../../../lib/admin'
import { clearAdminCookies, readAdminContext, requestOrigin } from '../../../../lib/auth'
import { withApi } from '../../../../lib/apiHandler'
import {
  listLiveSessions,
  revokeSession,
  revokeSessionsExcept,
  SESSION_ID_RE,
} from '../../../../lib/adminAuth/sessions'
import { requireRecentAuth } from '../../../../lib/adminAuth/stepUp'
import { endLegacyTokens, recordAuthEvent } from '../../../../lib/adminAuth/store'
import { log } from '../../../../lib/log'
import { revokeGrants } from '../../../../lib/ai/access'
import { voidOpenChanges } from '../../../../lib/ai/changes'

/**
 * Sign browsers out (admin only):
 *
 *   DELETE { id }                       → { ok, aiAppsEnded }  one browser (another one needs a recent verification)
 *   DELETE { others: true, endAiApps? } → { revoked, aiAppsEnded }
 *                                          every browser but this one (recent verification)
 *   DELETE { all: true }                → { revoked, aiAppsEnded }
 *                                          every browser, this one included: also bumps the
 *                                          session version (recent verification)
 *
 * A signed-out browser's next request is refused (lib/auth readAdminContext).
 * Every one of these also ends the tokens from before sessions existed (no
 * session id, so never listed or revocable one by one; lib/adminAuth/store
 * endLegacyTokens): signing any browser out leaves none of them valid. The
 * caller never holds one (each action needs a session row), so this never
 * signs the caller out by itself.
 *
 * Connected AI apps (design §5.4): signing ANOTHER browser out revokes the
 * apps that browser created (a stolen session may have made them) and
 * withdraws what they still had waiting; signing out this browser does not
 * (it suggests no compromise), nor does a session's natural end. Signing out
 * every other browser also ends every AI app unless `endAiApps: false` —
 * and even then the apps those browsers created end. "Everywhere" ends every
 * app: the session version they were bound to is gone, and they are revoked
 * outright. These calls live here, not in lib/adminAuth, so the sign-in code
 * never imports the AI layer.
 */

/** Revoke AI apps, withdraw their open changes and note it in the sign-in history; returns how many ended. */
function endAiApps(
  req: NextApiRequest,
  which: Parameters<typeof revokeGrants>[0],
  reason: string,
  sessionId: string | null
): number {
  try {
    const ended = revokeGrants(which, reason)
    if (!ended.length) return 0
    try {
      voidOpenChanges({ actorIds: ended }, 'ISSUER_ENDED')
    } catch (err) {
      log.error('AI changes of ended apps could not be withdrawn', { err })
    }
    recordAuthEvent({
      type: 'ai-apps-ended',
      sessionId,
      detail: `${ended.length} ${reason}`,
      ...requestOrigin(req),
    })
    return ended.length
  } catch (err) {
    log.error('AI apps could not be ended with the sign-out', { err })
    return 0
  }
}

export default withApi('admin/security/sessions', (req, res) => {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' })
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  res.setHeader('Cache-Control', 'no-store')
  const body = (req.body || {}) as { id?: unknown; others?: unknown; all?: unknown; endAiApps?: unknown }
  const origin = requestOrigin(req)
  const currentId = ctx.session?.id ?? null
  if (body.endAiApps !== undefined && (typeof body.endAiApps !== 'boolean' || body.others !== true))
    return res.status(400).json({ error: 'endAiApps is true or false, with { others: true }' })

  if (typeof body.id === 'string') {
    if (!SESSION_ID_RE.test(body.id)) return res.status(400).json({ error: 'Invalid session id' })
    const own = body.id === currentId
    if (!own && !requireRecentAuth(req, res)) return
    if (!revokeSession(body.id, own ? 'signed out' : 'signed out from another browser'))
      return res.status(404).json({ error: 'Not found' })
    endLegacyTokens()
    recordAuthEvent({ type: own ? 'signout' : 'session-revoked', sessionId: body.id, ...origin })
    if (own) {
      clearAdminCookies(req, res)
      return res.status(200).json({ ok: true, aiAppsEnded: 0 })
    }
    const aiAppsEnded = endAiApps(
      req,
      { createdSessions: [body.id] },
      'created from a browser that was signed out',
      currentId
    )
    return res.status(200).json({ ok: true, aiAppsEnded })
  }

  if (body.others === true || body.all === true) {
    if (!requireRecentAuth(req, res)) return
    const all = body.all === true
    // Who is about to be signed out (read in the same tick as the revoke: nothing runs in between).
    const leaving = listLiveSessions()
      .map((s) => s.id)
      .filter((id) => all || id !== currentId)
    const revoked = revokeSessionsExcept(
      all ? null : currentId,
      all ? 'signed out everywhere' : 'signed out from another browser'
    )
    endLegacyTokens()
    if (all) {
      bumpSessionVersion()
      clearAdminCookies(req, res)
    }
    recordAuthEvent({
      type: 'sessions-revoked',
      sessionId: currentId,
      detail: all ? `everywhere (${revoked})` : `other browsers (${revoked})`,
      ...origin,
    })
    const aiAppsEnded =
      all || body.endAiApps !== false
        ? endAiApps(
            req,
            { all: true },
            all ? 'ended by signing out everywhere' : 'ended with the other browsers',
            currentId
          )
        : endAiApps(
            req,
            { createdSessions: leaving },
            'created from browsers that were signed out',
            currentId
          )
    return res.status(200).json({ revoked, aiAppsEnded })
  }

  return res.status(400).json({ error: 'Send { id }, { others: true } or { all: true }' })
})
