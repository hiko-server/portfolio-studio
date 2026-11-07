import type { NextApiRequest, NextApiResponse } from 'next'
import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext } from '../../../../lib/auth'
import { requireRecentAuth, stepUpRequired } from '../../../../lib/adminAuth/stepUp'
import { recordAdminAudit } from '../../../../lib/audit/record'
import { authorizeHitsSince, consentsSince } from '../../../../lib/ai/oauth'
import { PAIRING_APPS, closePairingWindow, currentPairing, openPairingWindow, type PairingWindow } from '../../../../lib/ai/settings'
import { accessState } from '../../../../lib/ai/summary'

/**
 * The pairing window (admin only, never cached; design §6.4): "Allow a new
 * connection" in a client's tab of Connections. The main control against
 * consent phishing — an OAuth consent is only possible during the 10
 * minutes the owner opened for one app, and one grant closes it. Nothing
 * public can tell whether a window is open (/oauth/authorize and
 * /oauth/register answer the same either way).
 *
 *   GET    [?since=<ms>] → { pairing, consents }   the open window (its app,
 *          when it ends, how many /oauth/authorize requests arrived since it
 *          opened) and the consents given since `since` (when the Connections
 *          tab opened its window), so the tab can say when the app connected
 *   POST   { app }       → { pairing }             open one (step-up: opening
 *          loosens access, §5.2); a new window replaces any open one
 *   DELETE               → { closed }              close it (never asks:
 *          closing only reduces access)
 *
 * The window's id is never sent here: the consent page reads it from the
 * request check and must send it back unchanged.
 */

type PairingView = { app: PairingWindow['app']; openedAt: number; expiresAt: number; requests: number }

function viewOf(p: PairingWindow | null): PairingView | null {
  return p ? { app: p.app, openedAt: p.openedAt, expiresAt: p.expiresAt, requests: authorizeHitsSince(p.openedAt) } : null
}

function body(req: NextApiRequest): Record<string, unknown> {
  return (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
}

function open(req: NextApiRequest, res: NextApiResponse) {
  const app = body(req).app
  if (typeof app !== 'string' || !(PAIRING_APPS as readonly string[]).includes(app)) {
    // Checked before the step-up, so a typo never asks the owner to confirm it's them for nothing.
    if (!readAdminContext(req, res)) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
    return res.status(400).json({ code: 'INVALID', field: 'app', error: 'Choose the app to connect.' })
  }
  const ctx = requireRecentAuth(req, res)
  if (!ctx) return
  const state = accessState()
  if (!state.open) {
    return res.status(409).json(
      state.siteUrl
        ? { code: 'APPS_OFF', error: 'Turn on AI access and allow connected apps first.' }
        : { code: 'NO_SITE_URL', error: 'SITE_URL is not set on the server, so there is no address an app could connect to.' },
    )
  }
  const opened = openPairingWindow(app, { steppedUp: true })
  if (!opened.ok) return opened.code === 'STEP_UP_REQUIRED' ? stepUpRequired(res) : res.status(400).json({ code: 'INVALID', field: 'app', error: 'Choose the app to connect.' })
  recordAdminAudit(req, res, { action: 'ai.pairing-open', area: 'ai', target: app, summary: `Allowed a new connection for 10 minutes (${app})` })
  return res.status(200).json({ pairing: viewOf(opened.pairing) })
}

export default withApi('admin/ai/pairing', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'POST') return open(req, res)
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  if (req.method === 'GET') {
    const raw = Array.isArray(req.query.since) ? req.query.since[0] : req.query.since
    const since = raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : null
    return res.status(200).json({ pairing: viewOf(currentPairing()), consents: since === null ? [] : consentsSince(since) })
  }
  if (req.method === 'DELETE') {
    const closed = closePairingWindow()
    if (closed) recordAdminAudit(req, res, { action: 'ai.pairing-close', area: 'ai', summary: 'Closed the window for a new connection' })
    return res.status(200).json({ closed })
  }
  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
