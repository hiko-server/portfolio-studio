import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext } from '../../../../lib/auth'
import { aiSummary } from '../../../../lib/ai/summary'

/**
 * GET /api/admin/ai/summary → { access, apps: { connected, lastUsedAt }, waiting }
 * (admin only, never cached): the AI status strip's numbers, read fresh from
 * auth.db and ai.db (lib/ai/summary). `waiting` is null when ai.db cannot be
 * read.
 */
export default withApi('admin/ai/summary', (req, res) => {
  if (!readAdminContext(req, res)) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  return res.status(200).json(aiSummary())
})
