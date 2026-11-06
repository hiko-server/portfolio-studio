import { withApi } from '../../../lib/apiHandler'
import { bounceHtml } from '../../../lib/orcid/connectRoute'
import { aiPublicOpen } from '../../../lib/ai/settings'

/**
 * GET /ai/review/<id> (rewritten here by next.config.js while connected
 * apps are allowed; design §6.1) — the `review_url` a proposal returns: a
 * same-site bounce to the change's page in the admin, /admin/ai/change/<id>.
 *
 * It carries no data and grants nothing: the admin page asks the owner to
 * sign in if needed. Not a 302, which would stay part of the cross-site
 * navigation from the app (the SameSite=Strict session cookie would not be
 * sent and the owner would meet the sign-in form); a navigation this
 * same-origin page starts is same-site, so the admin opens signed in. The
 * id must be a change id (`ch_` and 16 base32 letters) before any bounce:
 * the bounce page checks only the leading slash, and a traversal such as
 * `../../../api/admin/orcid/connect` would otherwise become a same-site GET
 * of an admin route that acts when opened. Anything else is a plain 404.
 */
const ID_RE = /^ch_[a-z2-7]{16}$/

export default withApi('oauth/open', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  // The proxy already answers an unknown path's 404 while closed; this is the second check.
  if (!aiPublicOpen()) return res.status(404).end()
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).end()
  }
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  if (!ID_RE.test(id)) return res.status(404).end()
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Referrer-Policy', 'no-referrer')
  return res.status(200).send(bounceHtml(`/admin/ai/change/${id}`, { title: 'AI change', line: 'Opening the change…' }))
})
