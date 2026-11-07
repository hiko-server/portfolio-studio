import { withApi } from '../../../../../../lib/apiHandler'
import { readAdminContext, requestOrigin } from '../../../../../../lib/auth'
import { editorSaved } from '../../../../../../lib/ai/apply'
import { rateLimit } from '../../../../../../lib/rateLimit'

/**
 * POST /api/admin/ai/changes/<id>/editor-saved { version } — the owner's
 * editor saved a version that carries this AI change (design §7.8): a
 * suggestion applied in the editor, or a waiting MDX or page edit opened
 * there. The save itself went through the ordinary save route, unchanged;
 * this attributes it. `version` is what that save answered and must be the
 * document's version now. The change becomes `applied` with it, and the
 * activity log reads "AI-suggested · <who> · saved on <browser>" (lib/ai/
 * audit recordEditorSaved), linked to the version the save replaced.
 *
 *   200 { ok, state: 'applied', audited }
 *   409 { code: NOT_OPEN | NOT_EDITABLE | VERSION_MOVED, state }: nothing attributed; the save stands
 *
 * Under /api/admin/*: the proxy has checked the session and CSRF. Nothing
 * in the content changes here.
 */
export default withApi('admin/ai/changes/editor-saved', (req, res, ctx) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const admin = readAdminContext(req, res)
  if (!admin) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (!admin.session) return res.status(403).json({ code: 'SESSION_REQUIRED', error: 'Sign in again to save changes.' })
  const rl = rateLimit(req, 60, 10 * 60 * 1000, 'admin-ai-changes')
  if (!rl.allowed) return res.status(429).json({ error: 'Too many decisions in a short time — try again in a few minutes' })
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
  const origin = requestOrigin(req)
  const out = editorSaved(id, body.version, {
    session: { id: admin.session.id, device: admin.session.device ?? origin.device },
    origin: { ipPrefix: origin.ipPrefix, country: origin.country },
    requestId: ctx.requestId,
    log: ctx.log,
  })
  if (!out.ok) return res.status(out.status).json({ code: out.code, error: out.message, ...(out.state ? { state: out.state } : {}) })
  return res.status(200).json(out)
})
