import { withApi } from '../../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../../lib/auth'
import { recordAdminAudit } from '../../../../../../lib/audit/record'
import { CHANGE_ID_RE, rejectChange } from '../../../../../../lib/ai/apply'
import { changeRow } from '../../../../../../lib/ai/changes'
import { rateLimit } from '../../../../../../lib/rateLimit'

/**
 * POST /api/admin/ai/changes/<id>/reject { note? } — the owner turns a
 * waiting AI change down, or dismisses a suggestion sent to the editor
 * (design §7.8); the optional note (plain text, at most 500
 * characters) is what the app reads through get_change. Nothing is
 * written to the content. Recorded in the activity log (area ai).
 */
export default withApi('admin/ai/changes/reject', (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const admin = readAdminContext(req, res)
  if (!admin) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (!admin.session) return res.status(403).json({ code: 'SESSION_REQUIRED', error: 'Sign in again to decide changes.' })
  const rl = rateLimit(req, 60, 10 * 60 * 1000, 'admin-ai-changes')
  if (!rl.allowed) return res.status(429).json({ error: 'Too many decisions in a short time — try again in a few minutes' })
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  const row = CHANGE_ID_RE.test(id) ? changeRow(id) : null
  if (!row) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such change.' })
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
  const out = rejectChange(id, body.note, { id: admin.session.id })
  if (!out.ok) return res.status(out.status).json({ code: out.code, error: out.message, ...(out.state ? { state: out.state } : {}) })
  // A suggestion dismissed in the editor (§7.8) was never a change waiting on the site.
  if (row.state === 'in_editor') recordAdminAudit(req, res, { action: 'ai.dismiss', area: 'ai', target: id, summary: `Dismissed the AI suggestion “${row.title}”` })
  else recordAdminAudit(req, res, { action: 'ai.reject', area: 'ai', target: id, summary: `Rejected the AI change “${row.title}”` })
  return res.status(200).json(out)
})
