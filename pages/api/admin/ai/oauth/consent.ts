import type { NextApiRequest, NextApiResponse } from 'next'
import { withApi } from '../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../lib/auth'
import { requireFreshAuth } from '../../../../../lib/adminAuth/stepUp'
import { recordAdminAudit } from '../../../../../lib/audit/record'
import { isAccessLevel } from '../../../../../lib/ai/access'
import { authorizationResponse, checkAuthorizeRequest, issueCode, issuer, typedHostMatches } from '../../../../../lib/ai/oauth'
import { aiPublicOpen } from '../../../../../lib/ai/settings'

/**
 * POST /api/admin/ai/oauth/consent (admin only, cookie + the proxy's CSRF
 * guard, never cached; design §6.4): the owner's answer on the consent page.
 *
 *   { params, pairing_id, decision: 'allow', scopes, typedHost? } → { redirect }
 *   { params, decision: 'deny' }                                  → { redirect | null }
 *
 * `params` is the authorize query the page was opened with. Allow needs a
 * verification within the last 2 minutes (requireFreshAuth: a stolen cookie
 * inside the 10-minute window cannot connect an app silently), re-runs every
 * check of the request, needs the same pairing window the page was shown
 * (`pairing_id`), exactly one access level, and — unless the client and its
 * redirect URI are an exact known pair — the redirect host typed by the
 * owner. Then one transaction closes the window and stores a 60-second
 * single-use code (lib/ai/oauth issueCode), and the answer is the redirect
 * with code, state and iss, which the page follows with location.assign
 * after checking its scheme: no form post, so CSP `form-action 'self'`
 * never meets a cross-origin redirect.
 *
 * Deny never asks for a verification (refusing has no friction) and keeps
 * the window open, so the owner can start again from the app. A known pair
 * gets `error=access_denied` with state and iss; anything else gets
 * `redirect: null` and the page says so itself — Cancel on a request from an
 * unknown host is never an open redirect.
 */

/** A verification within this long allows a connection (§5.2). */
const FRESH_MS = 120_000
const PARAMS_MAX = 16 * 1024

type Body = Record<string, unknown>

function bodyOf(req: NextApiRequest): Body {
  return (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Body
}

function paramsOf(body: Body): URLSearchParams | null {
  return typeof body.params === 'string' && body.params.length <= PARAMS_MAX ? new URLSearchParams(body.params.replace(/^\?/, '')) : null
}

async function allow(req: NextApiRequest, res: NextApiResponse, body: Body) {
  const ctx = requireFreshAuth(req, res, FRESH_MS)
  if (!ctx) return
  const params = paramsOf(body)
  if (!params) return res.status(400).json({ code: 'INVALID', field: 'params', error: 'Open the connection again from the app.' })
  if (!aiPublicOpen()) return res.status(409).json({ code: 'CLOSED', error: 'Connected apps are off on this site.' })
  const checked = await checkAuthorizeRequest(params)
  if (checked.state === 'closed') return res.status(409).json({ code: 'CLOSED', error: 'This site is not expecting a new connection any more.' })
  if (checked.state === 'invalid') return res.status(400).json({ code: 'INVALID_REQUEST', error: checked.message })
  const { facts, request } = checked
  if (typeof body.pairing_id !== 'string' || body.pairing_id !== facts.pairingId) {
    return res.status(409).json({ code: 'WINDOW_CHANGED', error: 'A new window for connections was opened after this page loaded. Start the connection again from the app.' })
  }
  const scopes = Array.isArray(body.scopes) && body.scopes.every((s) => typeof s === 'string') ? (body.scopes as string[]) : null
  if (!scopes || !isAccessLevel(scopes)) return res.status(400).json({ code: 'INVALID', field: 'scopes', error: 'Choose an access level.' })
  if (!facts.known && !typedHostMatches(body.typedHost, facts.redirect.host)) {
    return res.status(400).json({ code: 'TYPED_HOST', field: 'typedHost', error: `Type ${facts.redirect.host} to allow it.` })
  }
  const sessionId = ctx.session?.id
  if (!sessionId) return res.status(401).json({ code: 'NO_SESSION', error: 'Sign in again to connect an app.' })
  const issued = issueCode({ request, pairingId: facts.pairingId, level: scopes.length, sessionId })
  if (!issued.ok) {
    if (issued.reason === 'window') return res.status(409).json({ code: 'WINDOW_CHANGED', error: 'The window for this connection closed. Allow a new connection in Connections and start again from the app.' })
    if (issued.reason === 'unavailable') return res.status(503).json({ code: 'UNAVAILABLE', error: 'The server can’t issue a connection right now.' })
    return res.status(400).json({ code: 'INVALID', field: issued.reason, error: 'Choose an access level.' })
  }
  recordAdminAudit(req, res, {
    action: 'ai.oauth-allow',
    area: 'ai',
    target: facts.redirect.host,
    summary: `Allowed an app to connect over OAuth (level ${scopes.length}, returns to ${facts.redirect.host})`,
  })
  return res.status(200).json({ redirect: issued.redirect, host: facts.redirect.host })
}

async function deny(req: NextApiRequest, res: NextApiResponse, body: Body) {
  if (!readAdminContext(req, res)) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  const params = paramsOf(body)
  const checked = params && aiPublicOpen() ? await checkAuthorizeRequest(params) : null
  if (!checked || checked.state !== 'ok') return res.status(200).json({ redirect: null })
  const host = checked.facts.redirect.host
  recordAdminAudit(req, res, { action: 'ai.oauth-deny', area: 'ai', target: host, summary: `Refused an app’s connection (returns to ${host})` })
  const iss = issuer()
  if (!checked.facts.known || !iss) return res.status(200).json({ redirect: null })
  return res.status(200).json({ redirect: authorizationResponse(checked.request.redirectUri, { error: 'access_denied', state: checked.request.state, iss }) })
}

export default withApi('admin/ai/oauth/consent', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const body = bodyOf(req)
  if (body.decision === 'allow') return allow(req, res, body)
  if (body.decision === 'deny') return deny(req, res, body)
  if (!readAdminContext(req, res)) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  return res.status(400).json({ code: 'INVALID', field: 'decision', error: 'Send decision "allow" or "deny".' })
})
