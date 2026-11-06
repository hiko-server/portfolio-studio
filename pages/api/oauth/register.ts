import { withApi } from '../../../lib/apiHandler'
import { registerClient } from '../../../lib/ai/oauth'
import { isJsonBody, oauthError, plainHttpRefused, readRawBody, spendOAuthBudget } from '../../../lib/ai/oauthRoutes'
import { aiPublicOpen } from '../../../lib/ai/settings'

/**
 * POST /oauth/register (design §6.4): OAuth Dynamic Client Registration
 * (RFC 7591) — deprecated by MCP, still what Cursor, Gemini CLI and
 * mcp-remote use. Stateless: the answer is the client, signed
 * (lib/ai/oauth registerClient), so nothing is stored, strangers cannot fill
 * a table or lock the owner out, and nothing needs pruning.
 *
 * The same answer and the same budget (5 an hour per client network) whether
 * or not the owner opened a pairing window: nothing public can tell. A
 * well-formed request always gets 201; every client is public (`none`),
 * whatever it asked for; its name is never treated as verified. JSON only,
 * at most 16 KB read.
 */

export const config = { api: { bodyParser: false } }

const BODY_MAX = 16 * 1024

export default withApi('oauth/register', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  if (!aiPublicOpen()) return res.status(404).end()
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return oauthError(res, 405, 'invalid_request', 'Use POST.')
  }
  if (plainHttpRefused(req)) return oauthError(res, 403, 'invalid_request', 'Use https.')
  const wait = spendOAuthBudget(req, 'registerPerNetwork', 'register')
  if (wait !== null) {
    res.setHeader('Retry-After', String(wait))
    return oauthError(res, 429, 'invalid_client_metadata', 'Too many registrations from this network. Try again later.')
  }
  if (!isJsonBody(req.headers['content-type'])) return oauthError(res, 400, 'invalid_client_metadata', 'Send the client metadata as application/json.')
  const raw = await readRawBody(req, BODY_MAX)
  if (!raw) return oauthError(res, 413, 'invalid_client_metadata', 'The client metadata is too large.')
  let input: unknown
  try {
    input = JSON.parse(raw.toString('utf8'))
  } catch {
    return oauthError(res, 400, 'invalid_client_metadata', 'The body is not JSON.')
  }
  const out = registerClient(input)
  if (!out.ok) return oauthError(res, out.status, out.error, out.description)
  return res.status(201).json(out.body)
})
