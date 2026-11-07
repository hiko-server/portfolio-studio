import { withApi } from '../../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../../lib/auth'
import { previewOf } from '../../../../../../lib/ai/changes'
import { compileForAi } from '../../../../../../lib/ai/compile'
import { bodyOfDocumentText, inertPreviewTree } from '../../../../../../lib/ai/previewTree'
import { rateLimit } from '../../../../../../lib/rateLimit'

/** A change id (lib/ai/apply CHANGE_ID_RE; that module stays out of this read-only route). */
const CHANGE_ID_RE = /^ch_[a-z2-7]{16}$/

/**
 * GET /api/admin/ai/changes/<id>/preview?doc=<n> → the review sheet's
 * Preview tab (design §8.2): document n of the change's stored preview, its
 * proposed body compiled by the site's renderer in the AI compile worker
 * (never on the main thread: the text came from a model), then made inert —
 * images from other sites, players and links replaced (lib/ai/previewTree),
 * so rendering it in the owner's browser loads nothing. Admin only, never
 * cached; nothing is written.
 *
 *   200 { tree, replaced: { images, embeds, links } }
 *   404 NOT_FOUND (no such change or document, or not an MDX text)
 *   422 { code: MDX_INVALID | MDX_TOO_COMPLEX }
 *   503 { code: CHECK_UNAVAILABLE }: the worker could not run it just now
 */
export default withApi('admin/ai/changes/preview', async (req, res) => {
  if (!readAdminContext(req, res)) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const rl = rateLimit(req, 120, 10 * 60 * 1000, 'admin-ai-preview')
  if (!rl.allowed) return res.status(429).json({ error: 'Too many previews, try again shortly' })
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  const docParam = typeof req.query.doc === 'string' ? req.query.doc : ''
  const preview = CHANGE_ID_RE.test(id) && /^\d{1,3}$/.test(docParam) ? previewOf(id) : null
  const doc = preview?.documents[Number(docParam)]
  if (!doc || doc.format !== 'mdx' || !doc.after) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such document.' })
  const verdict = await compileForAi({ body: bodyOfDocumentText(doc.after), render: true })
  if (!verdict.ok) {
    if (verdict.code === 'CHECK_UNAVAILABLE') return res.status(503).json({ code: verdict.code, error: 'The preview could not be rendered just now. Try again in a minute.' })
    if (verdict.code === 'MDX_TOO_COMPLEX') return res.status(422).json({ code: verdict.code, error: 'This text is too complex to render here.' })
    return res.status(422).json({ code: verdict.code, error: 'This text does not compile.' })
  }
  if (!verdict.rendered) return res.status(503).json({ code: 'CHECK_UNAVAILABLE', error: 'The preview could not be rendered just now.' })
  const { tree, replaced } = inertPreviewTree(verdict.rendered.tree)
  return res.status(200).json({ tree, replaced })
})
