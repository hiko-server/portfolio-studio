import { withApi } from '../../../lib/apiHandler'
import { isAdminRequest } from '../../../lib/auth'
import { deliverOpsAlert } from '../../../lib/ops/alerts'
import { configuredChannels } from '../../../lib/ops/push'

/**
 * The owner's notifications (lib/ops/alerts, lib/ops/push), admin only.
 *
 *   GET  → { mail: 'ready' | 'no-smtp' | 'no-recipient', channels: ['ntfy', …] }
 *          what is set up — names only, never a URL, token or address
 *   POST → { mail: 'sent' | 'skipped' | 'failed' | 'off', push: [{ channel, ok, status?, error? }] }
 *          sends a test notice to every channel now (no daily limit)
 */
export default withApi('admin/test-notify', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  // The proxy gates /api/admin/* too; this is the route's own session check (lib/auth.ts).
  if (!isAdminRequest(req, res)) return res.status(401).json({ error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'GET') {
    const e = process.env
    const smtp = !!(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS)
    const recipient = !!((e.NOTIFY_EMAIL || '').trim() || (e.ADMIN_EMAIL || '').trim())
    return res.status(200).json({ mail: !smtp ? 'no-smtp' : recipient ? 'ready' : 'no-recipient', channels: configuredChannels() })
  }
  const result = await deliverOpsAlert({ type: 'test' })
  return res.status(200).json(result)
})
