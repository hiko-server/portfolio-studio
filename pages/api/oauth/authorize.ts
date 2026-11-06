import type { NextApiResponse } from 'next'
import { withApi } from '../../../lib/apiHandler'
import { clientKey, rateLimitNetwork } from '../../../lib/rateLimit'
import { bounceHtml } from '../../../lib/orcid/connectRoute'
import { takeMemory, MEMORY_BUDGETS } from '../../../lib/ai/budgets'
import { AUTHORIZE_QUERY_MAX, noteAuthorizeHit } from '../../../lib/ai/oauth'
import { aiPublicOpen } from '../../../lib/ai/settings'

/**
 * GET /oauth/authorize (design §6.4): public, and deliberately blind. It reads
 * no cookie, stores nothing, fetches nothing and checks nothing about the
 * request, so it answers exactly the same whether or not the owner opened a
 * pairing window — nobody can poll it for the moment the owner is primed to
 * approve, and an anonymous call can never make the server fetch a client
 * document. It counts the hit (in memory, the time only: the consent page
 * says how many requests arrived during the window) and answers 200 with a
 * same-site bounce to /admin/ai/connect carrying the parameters, where all
 * validation happens behind the owner's session.
 *
 * A 200 page, not a 302: a redirect would still belong to the cross-site
 * navigation that brought the browser here, which does not carry the
 * SameSite=Strict session cookie; a navigation this same-origin page starts
 * does. No script (the CSP allows none inline), no referrer. Under /admin/,
 * so a signed-out owner signs in and comes back to it.
 *
 * Only two answers differ: a query over 4 KB (400) and too many requests
 * from one network (429), both static pages that never redirect.
 */

const PAGE = { title: 'Connecting an app', line: 'Opening the connection page…' }

function staticPage(res: NextApiResponse, status: number, title: string, line: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.status(status).send(
    [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="color-scheme" content="dark light">',
      '<meta name="robots" content="noindex, nofollow">',
      `<title>${esc(title)}</title>`,
      '<style>html{background:#050505;color:#ededed;font:15px/1.5 system-ui,sans-serif}@media (prefers-color-scheme: light){html{background:#fff;color:#111}}body{margin:0;padding:24px;max-width:60ch}</style>',
      '</head>',
      '<body>',
      `<h1 style="font-size:18px">${esc(title)}</h1>`,
      `<p>${esc(line)}</p>`,
      '</body>',
      '</html>',
    ].join('\n'),
  )
}

export default withApi('oauth/authorize', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (!aiPublicOpen()) return res.status(404).end()
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return staticPage(res, 405, 'Method not allowed', 'Open this address in a browser.')
  }
  const url = req.url || ''
  const at = url.indexOf('?')
  const query = at >= 0 ? url.slice(at + 1) : ''
  if (query.length > AUTHORIZE_QUERY_MAX) {
    return staticPage(res, 400, 'Connection request too long', 'This request is longer than any app needs. Start the connection again from the app.')
  }
  const rule = MEMORY_BUDGETS.oauthPerNetwork
  const spent = takeMemory('oauthPerNetwork', `authorize|${clientKey(req)}`)
  const network = rateLimitNetwork(req, rule.limit, rule.windowMs, 'oauth-authorize')
  if (!spent.ok || !network.allowed) {
    const retryAfter = spent.ok ? Math.max(1, Math.ceil((network.resetAt - Date.now()) / 1000)) : spent.retryAfterS
    res.setHeader('Retry-After', String(retryAfter))
    return staticPage(res, 429, 'Too many connection requests', 'Wait a few minutes, then start the connection again from the app.')
  }
  noteAuthorizeHit()
  const params = new URLSearchParams(query).toString()
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  return res.status(200).send(bounceHtml(`/admin/ai/connect${params ? `?${params}` : ''}`, PAGE))
})
