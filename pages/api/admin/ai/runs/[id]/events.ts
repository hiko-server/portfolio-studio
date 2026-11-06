import { withApi } from '../../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../../lib/auth'
import { RUN_ID_RE } from '../../../../../../lib/ai/conversations'
import { pipeRun, runView } from '../../../../../../lib/ai/runs'

/**
 * Re-attach to a run (admin only; design §7.7):
 * GET /api/admin/ai/runs/<id>/events?after=<seq> → text/event-stream with
 * every kept event after `seq`, then the live ones, until `run_end`. Reload
 * and navigation resume here; a finished step is never lost (its `turn`
 * event is kept, and it is in the conversation). A run this process does not
 * drive answers one stored `run_end` (`interrupted` after a restart).
 */

export const config = { api: { responseLimit: false } }

export default withApi(
  'admin/ai/runs/events',
  async (req, res) => {
    const ctx = readAdminContext(req, res)
    if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return res.status(405).json({ error: 'Method not allowed' })
    }
    const id = typeof req.query.id === 'string' ? req.query.id : ''
    if (!RUN_ID_RE.test(id) || !runView(id)) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such run.' })
    const rawAfter = typeof req.query.after === 'string' ? req.query.after : '0'
    const after = /^\d{1,9}$/.test(rawAfter) ? Number(rawAfter) : 0
    await pipeRun(res, id, after)
  },
  { longLived: true },
)
