import { withApi } from '../../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../../lib/auth'
import { RUN_ID_RE } from '../../../../../../lib/ai/conversations'
import { runView, stopRun } from '../../../../../../lib/ai/runs'

/**
 * Stop a run (admin only; design §7.5): POST /api/admin/ai/runs/<id>/stop.
 * The model call is aborted and its partial answer kept for the owner as
 * "(stopped)", out of the history; a tool already running finishes, the
 * ones after it are answered "cancelled by user". Proposals the run made stay
 * waiting and approvable. Answers `{ stopped }`: false when the run had
 * already ended (or is not driven by this process).
 */

export default withApi('admin/ai/runs/stop', (req, res) => {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  if (!RUN_ID_RE.test(id)) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such run.' })
  const stopped = stopRun(id, 'stopped')
  const view = runView(id)
  if (!view) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such run.' })
  return res.status(200).json({ stopped, run: view })
})
