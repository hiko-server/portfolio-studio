import { withApi } from '../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../lib/auth'
import { listChanges } from '../../../../../lib/ai/changeViews'
import { waitingCount } from '../../../../../lib/ai/changes'

/**
 * GET /api/admin/ai/changes?state=waiting|done|all&app=<grant or run id>&area=<target kind>&cursor=
 *   → { items, next_cursor, waiting }   (admin only, never cached)
 *
 * The Changes view: what AI asked for and what became of it. Waiting
 * changes come oldest first (the queue); decided ones newest first. A list
 * item carries no preview: one change's card is GET ./[id].
 */
const STATES = new Set(['waiting', 'done', 'all'])

export default withApi('admin/ai/changes', (req, res) => {
  if (!readAdminContext(req, res)) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const one = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const state = one(req.query.state) ?? 'waiting'
  if (!STATES.has(state)) return res.status(400).json({ error: 'state must be waiting, done or all' })
  const app = one(req.query.app)
  const area = one(req.query.area)
  if ((app !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(app)) || (area !== undefined && !/^[a-z]{1,16}$/.test(area))) return res.status(400).json({ error: 'Invalid filter' })
  const now = Date.now()
  const page = listChanges({ state: state as 'waiting' | 'done' | 'all', actorId: app, area, cursor: one(req.query.cursor) }, now)
  return res.status(200).json({ ...page, waiting: waitingCount(now) })
})
