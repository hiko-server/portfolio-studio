import { withApi } from '../../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../../lib/auth'
import { CHANGE_ID_RE } from '../../../../../../lib/ai/apply'
import { changeDetail } from '../../../../../../lib/ai/changeViews'
import { changeRow } from '../../../../../../lib/ai/changes'

/**
 * GET /api/admin/ai/changes/<id> → one change's card (admin only, never
 * cached): its state, the stored preview with `preview_sha256` (approving
 * sends that hash back, so only this exact preview can be approved), what
 * it produced, whether Undo is possible now, and display-only notes. The
 * state a change replaced never leaves the server.
 */
export default withApi('admin/ai/changes/item', (req, res) => {
  if (!readAdminContext(req, res)) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  const row = CHANGE_ID_RE.test(id) ? changeRow(id) : null
  if (!row) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such change.' })
  return res.status(200).json(changeDetail(row))
})
