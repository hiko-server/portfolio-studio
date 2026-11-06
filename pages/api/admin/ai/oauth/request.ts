import { withApi } from '../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../lib/auth'
import { checkAuthorizeRequest } from '../../../../../lib/ai/oauth'
import { aiPublicOpen } from '../../../../../lib/ai/settings'

/**
 * GET /api/admin/ai/oauth/request?<the authorize parameters> (admin only,
 * cookie, never cached; design §6.4): what the consent page shows. All the
 * validation of an authorization request happens here, behind the owner's
 * session, never on the public /oauth/authorize — and only while a pairing
 * window is open, so a phishing link on a random day changes nothing and
 * fetches nothing.
 *
 *   { state: 'closed', apps }                  no window open (apps: whether
 *                                              connected apps are on at all)
 *   { state: 'invalid', error, message }       a page on this site, never a
 *                                              redirect (RFC 9700 §2.1)
 *   { state: 'ok', facts }                     who is asking, where it returns,
 *                                              the level it asks for, how many
 *                                              requests arrived this window
 */

/** The query a consent page sends back is the authorize query re-encoded: at most 4 KB raw, a few times that encoded. */
const QUERY_MAX = 16 * 1024

export default withApi('admin/ai/oauth/request', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  if (!readAdminContext(req, res)) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  if (!aiPublicOpen()) return res.status(200).json({ state: 'closed', apps: false })
  const url = req.url || ''
  const at = url.indexOf('?')
  const query = at >= 0 ? url.slice(at + 1) : ''
  if (query.length > QUERY_MAX) return res.status(200).json({ state: 'invalid', error: 'invalid_request', message: 'This request is longer than any app needs. Start the connection again from the app.' })
  const checked = await checkAuthorizeRequest(new URLSearchParams(query))
  if (checked.state === 'ok') return res.status(200).json({ state: 'ok', facts: checked.facts })
  if (checked.state === 'closed') return res.status(200).json({ state: 'closed', apps: true })
  return res.status(200).json({ state: 'invalid', error: checked.error, message: checked.message })
})
