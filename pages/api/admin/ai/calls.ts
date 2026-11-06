import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext } from '../../../../lib/auth'
import { listCalls } from '../../../../lib/ai/changeViews'

/**
 * GET /api/admin/ai/calls?app=<grant or run id>&cursor= → { items, next_cursor }
 * (admin only, never cached): Changes → All calls — every tool call and
 * refused token of the last 30 days (ai.db ai_tool_calls), newest first:
 * the tool, the target's slug, the outcome, sizes, the network. Never
 * arguments, results or prompts: they are not stored.
 */
export default withApi('admin/ai/calls', (req, res) => {
  if (!readAdminContext(req, res)) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const app = typeof req.query.app === 'string' ? req.query.app : undefined
  if (app !== undefined && !/^[A-Za-z0-9_()-]{1,64}$/.test(app)) return res.status(400).json({ error: 'Invalid filter' })
  return res.status(200).json(listCalls({ actorId: app, cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined }))
})
