import { withApi } from '../../../../../../lib/apiHandler'
import { readAdminClaims, readAdminContext, requestOrigin } from '../../../../../../lib/auth'
import { runInAuditScope, type AuditScope } from '../../../../../../lib/audit/context'
import { recordAdminAudit } from '../../../../../../lib/audit/record'
import { CHANGE_ID_RE, undoChange } from '../../../../../../lib/ai/apply'
import { changeRow } from '../../../../../../lib/ai/changes'
import { ownerMail } from '../../../../../../lib/contentOps/notify'
import { emitEditorialEvent } from '../../../../../../lib/editorialEvents'
import { rateLimit } from '../../../../../../lib/rateLimit'

/**
 * POST /api/admin/ai/changes/<id>/undo — the owner puts back the state an
 * applied AI change replaced (single-target kinds only), while the target
 * is still at the version the change wrote (409 CHANGED_SINCE otherwise).
 * The owner's own action, so no step-up; recorded in the activity log
 * (area ai) with the history versions it took.
 *
 *   200 { ok, state: 'undone', refreshed }
 */
export default withApi('admin/ai/changes/undo', async (req, res, ctx) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const admin = readAdminContext(req, res)
  if (!admin) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (!admin.session) return res.status(403).json({ code: 'SESSION_REQUIRED', error: 'Sign in again to undo changes.' })
  const rl = rateLimit(req, 60, 10 * 60 * 1000, 'admin-ai-changes')
  if (!rl.allowed) return res.status(429).json({ error: 'Too many decisions in a short time — try again in a few minutes' })
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  const row = CHANGE_ID_RE.test(id) ? changeRow(id) : null
  if (!row) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such change.' })
  const origin = requestOrigin(req)
  const scope: AuditScope = { snapshots: [] }
  const out = await runInAuditScope(scope, () =>
    undoChange(id, {
      session: { id: admin.session!.id, device: admin.session!.device ?? origin.device },
      origin: { ipPrefix: origin.ipPrefix, country: origin.country },
      requestId: ctx.requestId,
      log: ctx.log,
      res,
      notify: (event) => emitEditorialEvent(event, { req }),
      mail: ownerMail(ctx.log),
      ownerEmail: readAdminClaims(req, res)?.email,
    }),
  )
  if (!out.ok) return res.status(out.status).json({ code: out.code, error: out.message, ...(out.state ? { state: out.state } : {}) })
  recordAdminAudit(req, res, { action: 'ai.undo', area: 'ai', target: id, summary: `Undid the AI change “${row.title}”` }, { snapshots: scope.snapshots })
  return res.status(200).json(out)
})
