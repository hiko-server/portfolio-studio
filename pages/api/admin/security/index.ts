import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext } from '../../../../lib/auth'
import { log } from '../../../../lib/log'
import { securityOverview } from '../../../../lib/adminAuth/overview'
import { passwordOverview } from '../../../../lib/adminAuth/password'
import { securityAiFacts, type SecurityAiFacts } from '../../../../lib/ai/summary'

/**
 * GET /api/admin/security — the Security page: passkeys, recovery-code
 * status, the "Require a passkey" policy, the password card (account address
 * for password managers, rules, last change, and whether ADMIN_PASS in the
 * server's environment still equals the password — computed here, never
 * sent), signed-in browsers, the sign-in history and how recently this
 * browser verified (admin only, never cached).
 *
 * `ai`: the connected AI apps that may act, whether they can reach the site
 * now, and how many each signed-in browser created (design §8.5) — null when
 * the AI stores cannot be read, so the rest of the page never depends on them.
 * Read here, not in lib/adminAuth, so the sign-in code never imports the AI layer.
 */
export default withApi('admin/security', async (req, res) => {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ error: 'Unauthorized' })
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  res.setHeader('Cache-Control', 'no-store')
  let ai: SecurityAiFacts | null = null
  try {
    ai = securityAiFacts()
  } catch (err) {
    log.warn('Security page: AI apps unavailable', { err })
  }
  return res.status(200).json({ ...securityOverview(req, ctx), password: await passwordOverview(), ai })
})
