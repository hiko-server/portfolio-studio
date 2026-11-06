import { withApi } from '../../../../../../lib/apiHandler'
import { readAdminContext, readAdminClaims, requestOrigin } from '../../../../../../lib/auth'
import { requireRecentAuth } from '../../../../../../lib/adminAuth/stepUp'
import { CHANGE_ID_RE, approveChange } from '../../../../../../lib/ai/apply'
import { changeRow } from '../../../../../../lib/ai/changes'
import { ownerMail } from '../../../../../../lib/contentOps/notify'
import { emitEditorialEvent } from '../../../../../../lib/editorialEvents'
import { rateLimit } from '../../../../../../lib/rateLimit'

/**
 * POST /api/admin/ai/changes/<id>/approve { preview_sha256 } — the owner
 * applies a waiting AI change (design §5.3; lib/ai/apply approveChange runs
 * the exact order). Under /api/admin/*, so the proxy has already refused a
 * bearer token and checked the session and CSRF; a destructive change also
 * needs a recent sign-in (403 STEP_UP_REQUIRED). The posted hash binds the
 * approval to the card the owner saw.
 *
 *   200 { ok, state: 'applied', result }
 *   409 { code: STALE_CARD | EXPIRED | VOIDED | CONFLICT | FAILED | NOT_WAITING, state }
 *
 * The write is recorded in the activity log by lib/ai/audit, fail closed,
 * as approved by this browser.
 */
export default withApi('admin/ai/changes/approve', async (req, res, ctx) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const admin = readAdminContext(req, res)
  if (!admin) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (!admin.session) return res.status(403).json({ code: 'SESSION_REQUIRED', error: 'Sign in again to approve changes.' })
  const rl = rateLimit(req, 60, 10 * 60 * 1000, 'admin-ai-changes')
  if (!rl.allowed) return res.status(429).json({ error: 'Too many decisions in a short time — try again in a few minutes' })
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  const row = CHANGE_ID_RE.test(id) ? changeRow(id) : null
  if (!row) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such change.' })
  // A destructive change (unpublish, restore, delete) needs a recent sign-in, like deleting by hand.
  let recentAuth = false
  if (row.risk === 'destructive') {
    if (!requireRecentAuth(req, res)) return
    recentAuth = true
  }
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
  const origin = requestOrigin(req)
  const out = await approveChange(id, body.preview_sha256, {
    recentAuth,
    session: { id: admin.session.id, device: admin.session.device ?? origin.device },
    origin: { ipPrefix: origin.ipPrefix, country: origin.country },
    requestId: ctx.requestId,
    log: ctx.log,
    res,
    notify: (event) => emitEditorialEvent(event, { req }),
    mail: ownerMail(ctx.log),
    ownerEmail: readAdminClaims(req, res)?.email,
  })
  if (!out.ok) return res.status(out.status).json({ code: out.code, error: out.message, ...(out.state ? { state: out.state } : {}) })
  return res.status(200).json(out)
})
