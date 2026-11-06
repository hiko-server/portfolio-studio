import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext } from '../../../../lib/auth'
import { hasFreshAuth, recentAuthWindowMs, stepUpMethods } from '../../../../lib/adminAuth/stepUp'

/**
 * GET /api/admin/security/recent[?within=<ms>] → { recent, recentUntil, methods, recoveryRequired, windowMinutes }
 *
 * Asked by the admin right before a dangerous action, so the "Confirm it's
 * you" dialog opens first instead of after a 403 (which the browser would log
 * as a failed request). The action's route still enforces the rule itself
 * (lib/adminAuth/stepUp.ts requireRecentAuth). `within` asks about a stricter
 * window — the 2 minutes of requireFreshAuth, before a connected app's token
 * is made — and is never longer than the recent-auth window.
 */

/** `within` as whole milliseconds from 1 s up to the recent-auth window; anything else means the window itself. */
function windowFor(raw: string | string[] | undefined, recent: number): number {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (typeof v !== 'string' || !/^\d{4,7}$/.test(v)) return recent
  return Math.min(recent, Number(v))
}

export default withApi('admin/security/recent', (req, res) => {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' })
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  res.setHeader('Cache-Control', 'no-store')
  const windowMs = recentAuthWindowMs()
  const askedMs = windowFor(req.query.within, windowMs)
  const recent = hasFreshAuth(ctx, askedMs)
  return res.status(200).json({
    recent,
    recentUntil: recent && ctx.session ? ctx.session.verifiedAt + askedMs : null,
    ...stepUpMethods(),
    windowMinutes: windowMs / 60_000,
  })
})
