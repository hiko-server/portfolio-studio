import { withApi } from '../../../lib/apiHandler'
import { parseForm, revokeByToken } from '../../../lib/ai/oauth'
import { isFormBody, oauthError, plainHttpRefused, readRawBody, recordGrantEnded } from '../../../lib/ai/oauthRoutes'
import { aiPublicOpen } from '../../../lib/ai/settings'

/**
 * POST /oauth/revoke (design §6.1): RFC 7009 token revocation, for an OAuth
 * client disconnecting itself. A form with `token` (and optionally
 * `token_type_hint`, `client_id`). An access or refresh token of an OAuth
 * grant ends the whole grant on the next request and withdraws what it still
 * had waiting (lib/ai/oauth revokeByToken; the tag is checked first, so a
 * guessed token never reads the store). Always 200 for a well-formed
 * request, whether or not the token meant anything, so the answer tells
 * nothing; personal tokens are ended in Connections, not here.
 */

export const config = { api: { bodyParser: false } }

const BODY_MAX = 4 * 1024

export default withApi('oauth/revoke', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  if (!aiPublicOpen()) return res.status(404).end()
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return oauthError(res, 405, 'invalid_request', 'Use POST.')
  }
  if (plainHttpRefused(req)) return oauthError(res, 403, 'invalid_request', 'Use https.')
  if (!isFormBody(req.headers['content-type'])) return oauthError(res, 400, 'invalid_request', 'Send the parameters as application/x-www-form-urlencoded.')
  const raw = await readRawBody(req, BODY_MAX)
  if (!raw) return oauthError(res, 413, 'invalid_request', 'The request body is too large.')
  const form = parseForm(raw.toString('utf8'))
  if (!form || !form.get('token')) return oauthError(res, 400, 'invalid_request', form ? 'token is missing.' : 'A parameter appears more than once.')
  const { ended } = revokeByToken(form)
  if (ended) recordGrantEnded(req, res, ended, 'app-revoked')
  return res.status(200).end()
})
