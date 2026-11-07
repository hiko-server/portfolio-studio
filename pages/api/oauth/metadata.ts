import { withApi } from '../../../lib/apiHandler'
import { aiPublicOpen } from '../../../lib/ai/settings'
import { authorizationServerMetadata, protectedResourceMetadata } from '../../../lib/ai/oauth'

/**
 * The discovery documents (design §6.1, §6.4), public while AI access with
 * connected apps is open (lib/aiPublicRoutes.js rewrites the addresses):
 *
 *   /.well-known/oauth-protected-resource/mcp, /.well-known/oauth-protected-resource
 *        → ?doc=prm   RFC 9728 Protected Resource Metadata of /mcp
 *   /.well-known/oauth-authorization-server
 *        → ?doc=as    RFC 8414 Authorization Server Metadata
 *
 * Built from SITE_URL, never from the Host header. Nothing secret in them, so
 * any origin may read them (`Access-Control-Allow-Origin: *`, the preflight a
 * browser-run client sends for MCP-Protocol-Version included) and caches may
 * keep them five minutes; this route's own Cache-Control wins over the
 * proxy's no-store. Closed, a bare 404 (the proxy already answers like an
 * unknown path).
 */
export default withApi('oauth/metadata', (req, res) => {
  if (!aiPublicOpen()) {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(404).end()
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS')
    res.setHeader('Cache-Control', 'no-store')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const doc = req.query.doc === 'prm' ? protectedResourceMetadata() : req.query.doc === 'as' ? authorizationServerMetadata() : null
  if (!doc) {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(404).end()
  }
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'MCP-Protocol-Version')
    res.setHeader('Access-Control-Max-Age', '300')
    res.setHeader('Cache-Control', 'no-store')
    return res.status(204).end()
  }
  res.setHeader('Cache-Control', 'public, max-age=300')
  return res.status(200).json(doc)
})
