import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext } from '../../../../lib/auth'
import { ACCESS_LEVELS } from '../../../../lib/ai/access'
import { catalogueView } from '../../../../lib/ai/registry'

/**
 * GET /api/admin/ai/catalogue → { tools, levels } (admin only, never cached).
 *
 * What connected apps can do, straight from the tool registry (design §8.6
 * ToolCatalogue: rendered from this, never hand-written): each tool's name,
 * title, description, risk, cost and the lowest access level that includes
 * it; never a schema. The page lists it whether or not AI access is on, so
 * the owner can see what turning it on would allow.
 */
export default withApi('admin/ai/catalogue', (req, res) => {
  if (!readAdminContext(req, res)) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  return res.status(200).json({
    tools: catalogueView(),
    levels: ACCESS_LEVELS.map((scopes, i) => ({ level: i + 1, scopes: [...scopes] })),
  })
})
