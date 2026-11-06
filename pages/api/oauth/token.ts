import type { PageConfig } from 'next'
import { withApi } from '../../../lib/apiHandler'
import { aiAlert } from '../../../lib/ai/alerts'
import { exchangeCode, parseForm, refreshTokens } from '../../../lib/ai/oauth'
import { isFormBody, oauthError, plainHttpRefused, readRawBody, recordGrantEnded, recordGrantMade, spendOAuthBudget } from '../../../lib/ai/oauthRoutes'
import { aiPublicOpen } from '../../../lib/ai/settings'

/**
 * POST /oauth/token (design §6.4): the code exchange and the refresh
 * rotation of the OAuth clients of /mcp. Public, and outside /api/admin and
 * /api/auth on purpose: the proxy answers form bodies there with 415 (THREATS
 * F12). `application/x-www-form-urlencoded` only, each parameter once, at
 * most 16 KB; never cached; synchronous, so it answers well within the 10
 * seconds a client waits.
 *
 *   grant_type=authorization_code  code, code_verifier, redirect_uri,
 *                                  client_id (and resource): lib/ai/oauth exchangeCode
 *   grant_type=refresh_token       refresh_token (client_id, resource, scope
 *                                  optional): lib/ai/oauth refreshTokens
 *
 * Every client is public (`none`): nothing here reads a client secret or an
 * Authorization header. Refusals carry RFC 6749 codes only. A used code or a
 * rotated refresh token that comes back after its grace ends the grant it
 * belongs to: that is recorded (Activity, the sign-in history) and mailed.
 * The body is never logged: it holds the code, the verifier or a token.
 */

export const config: PageConfig = { api: { bodyParser: false } }

const BODY_MAX = 16 * 1024

export default withApi('oauth/token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  if (!aiPublicOpen()) return res.status(404).end()
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return oauthError(res, 405, 'invalid_request', 'Use POST.')
  }
  if (plainHttpRefused(req)) return oauthError(res, 403, 'invalid_request', 'Use https.')
  const wait = spendOAuthBudget(req, 'oauthPerNetwork', 'token')
  if (wait !== null) {
    res.setHeader('Retry-After', String(wait))
    return oauthError(res, 429, 'invalid_request', 'Too many token requests from this network. Try again later.')
  }
  if (!isFormBody(req.headers['content-type'])) return oauthError(res, 400, 'invalid_request', 'Send the parameters as application/x-www-form-urlencoded.')
  const raw = await readRawBody(req, BODY_MAX)
  if (!raw) return oauthError(res, 413, 'invalid_request', 'The request body is too large.')
  const form = parseForm(raw.toString('utf8'))
  if (!form) return oauthError(res, 400, 'invalid_request', 'A parameter appears more than once.')

  const grantType = form.get('grant_type')
  const answer =
    grantType === 'authorization_code'
      ? exchangeCode(form, { onEvent: aiAlert })
      : grantType === 'refresh_token'
        ? refreshTokens(form)
        : null
  if (!answer) return oauthError(res, 400, grantType ? 'unsupported_grant_type' : 'invalid_request', grantType ? 'Only authorization_code and refresh_token are supported.' : 'grant_type is missing.')
  if (!answer.ok) {
    if (answer.ended) {
      const what = grantType === 'authorization_code' ? 'authorization code' : 'refresh token'
      recordGrantEnded(req, res, answer.ended, grantType === 'authorization_code' ? 'code-replay' : 'refresh-reuse')
      aiAlert({ type: 'replay', grantId: answer.ended.id, label: answer.ended.name, what })
    }
    return oauthError(res, answer.status, answer.error, answer.description)
  }
  if (answer.created) recordGrantMade(req, res, answer.grant)
  return res.status(200).json(answer.body)
})
