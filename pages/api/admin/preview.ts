import { withApi } from '../../../lib/apiHandler'
import { isAdminRequest } from '../../../lib/auth'
import { rateLimit } from '../../../lib/rateLimit'
import { compileForAdmin } from '../../../lib/mdx-admin'
import { compileForAi } from '../../../lib/ai/compile'
import { inertPreviewTree } from '../../../lib/ai/previewTree'

/**
 * POST /api/admin/preview { body } — compile an unsaved MDX body with the
 * public renderer and return what the article page would render:
 *
 *   200 { tree, toc }  (hast tree for <ArticleBody tree toc />)
 *   422 { code:'MDX_INVALID', line, column, reason, error }
 *
 * Used by the editors' live preview (debounced) and as the dry run behind
 * the Publish checklist. Nothing is stored. Admin-only (proxy gate plus
 * the session check here), rate-limited per client.
 *
 * `{ body, localOnly: true }` — an editor holding AI edits it has not saved
 * (design §7.8): the body is compiled in the AI compile worker with no
 * resolvers (no request to another host, no disk, no database), and the
 * tree is made inert (lib/ai/previewTree: images from other sites, players
 * and links replaced) so rendering it in the browser loads nothing either.
 *
 *   200 { tree, toc, localOnly: true, replaced }
 *   422 { code: MDX_INVALID | MDX_TOO_COMPLEX, ... }
 *   503 { code: CHECK_UNAVAILABLE }
 */
export default withApi('admin/preview', async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  if (!isAdminRequest(req, res)) return res.status(401).json({ error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  const rl = rateLimit(req, 120, 10 * 60 * 1000)
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))))
    return res.status(429).json({ error: 'Too many previews, try again shortly' })
  }
  const body = (req.body || {}).body
  if (typeof body !== 'string') return res.status(400).json({ error: 'body must be a string' })

  if ((req.body || {}).localOnly === true) {
    const verdict = await compileForAi({ body, render: true })
    if (!verdict.ok) {
      if (verdict.code === 'MDX_INVALID') {
        const where = verdict.line !== null ? `Line ${verdict.line}${verdict.column !== null ? `:${verdict.column}` : ''}: ` : ''
        return res.status(422).json({ code: 'MDX_INVALID', line: verdict.line, column: verdict.column, reason: verdict.reason, error: `${where}${verdict.reason}` })
      }
      if (verdict.code === 'MDX_TOO_COMPLEX') return res.status(422).json({ code: 'MDX_TOO_COMPLEX', line: null, column: null, reason: 'This body is too complex to preview here.', error: 'This body is too complex to preview here.' })
      return res.status(503).json({ code: 'CHECK_UNAVAILABLE', error: 'The preview could not be rendered just now.' })
    }
    if (!verdict.rendered) return res.status(503).json({ code: 'CHECK_UNAVAILABLE', error: 'The preview could not be rendered just now.' })
    const { tree, replaced } = inertPreviewTree(verdict.rendered.tree)
    return res.status(200).json({ tree, toc: verdict.rendered.toc ?? [], localOnly: true, replaced })
  }

  const out = await compileForAdmin(body)
  if (!out.ok) return res.status(422).json(out.problem)
  return res.status(200).json({ tree: out.tree, toc: out.toc })
})

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } }
