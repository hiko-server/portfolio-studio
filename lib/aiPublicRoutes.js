/**
 * The public AI addresses (design §6.1) and how they are routed: shared by
 * proxy.ts and next.config.js, so CommonJS (next.config.js requires it).
 *
 *   /mcp                                       → /api/mcp            (MCP, Streamable HTTP)
 *   /.well-known/oauth-protected-resource[/mcp] → /api/oauth/metadata?doc=prm
 *   /.well-known/oauth-authorization-server    → /api/oauth/metadata?doc=as
 *   /oauth/authorize|token|register|revoke     → /api/oauth/<endpoint>
 *   /ai/review/<id>                            → /api/oauth/open?id=<id>
 *
 * While AI access is closed (off, connected apps not allowed, SITE_URL
 * unset — lib/ai/settings aiPublicOpen) every one of these, and the
 * implementation routes /api/mcp and /api/oauth/* themselves, must answer
 * exactly what an unknown path answers: status, body and every header.
 *
 * So the routing is decided by a request header only the proxy sets:
 * proxy.ts removes whatever a client sent under AI_OPEN_HEADER from every
 * request it passes on, whatever the path, and sets it only on these paths
 * while AI access is open. The rewrites below fire only with it; without it
 * the public addresses are not rewritten at all (no page serves them: Next's
 * ordinary 404), and the implementation routes are rewritten to a path no
 * page serves. Fail closed: a request the proxy did not mark is a closed one.
 *
 * Every path, because Next's router equates spellings with these addresses
 * that a path test cannot all foresee: it matches rewrite sources without
 * regard to case (experimental.caseSensitiveRoutes is off: /MCP is /mcp), with
 * an optional trailing slash (left on a Next data request, which the proxy
 * does not redirect), and reads /_next/data/<build>/mcp.json as /mcp.
 *
 * Not a proxy rewrite (NextResponse.rewrite): Next answers those with an
 * `x-middleware-rewrite` response header, which an unknown path never
 * carries. A config rewrite announces itself too, but only to a request
 * carrying `rsc: 1` (`x-nextjs-rewritten-path`; the proxy cannot remove that
 * request header — Next puts it back). So every unknown /api/* path takes the
 * same kind of rewrite as a closed implementation route (apiFallbackRewrite:
 * /api/<rest> → /__not_found/<rest>): under that probe both name
 * /__not_found/<rest>, for any other request nothing changes. <rest> exactly
 * as the request spelled it: the closed rules capture their literal segments
 * (`:route(mcp)`, `:area(oauth)`) instead of writing them, or /API/MCP would
 * come out as /__not_found/mcp where an unknown /API/ZZ keeps its case.
 */

const AI_OPEN_HEADER = 'x-ai-open'
/** Where a closed implementation route goes, like any unknown /api/* path: under a path no page or route serves. */
const AI_CLOSED_TARGET = '/__not_found'

/**
 * Is `pathname` one of the public AI addresses or their implementation
 * routes, in any letter case? Read as Next's router reads a rewrite source
 * (case-insensitively), so every spelling it routes to an AI route while open
 * gets the proxy's AI handling: the mark and the admin context's no-store and
 * noindex (tests/ai-closed-state checks this against Next's own matcher).
 */
function isAiPublicPath(pathname) {
  const p = pathname.toLowerCase()
  return (
    p === '/mcp' ||
    p === '/api/mcp' ||
    p.startsWith('/oauth/') ||
    p.startsWith('/api/oauth/') ||
    p.startsWith('/.well-known/oauth-') ||
    p.startsWith('/ai/review/')
  )
}

/** next.config.js `rewrites().beforeFiles` entries for the AI addresses. */
function aiPublicRewrites() {
  const open = [{ type: 'header', key: AI_OPEN_HEADER, value: '1' }]
  return [
    // Closed: the implementation routes do not exist either (the same target, in the request's own letter case, that
    // an unknown /api/* path gets).
    { source: '/api/:route(mcp)', missing: open, destination: `${AI_CLOSED_TARGET}/:route` },
    { source: '/api/:area(oauth)/:path+', missing: open, destination: `${AI_CLOSED_TARGET}/:area/:path+` },
    // Open: the public addresses reach them.
    { source: '/mcp', has: open, destination: '/api/mcp' },
    { source: '/.well-known/oauth-protected-resource/mcp', has: open, destination: '/api/oauth/metadata?doc=prm' },
    { source: '/.well-known/oauth-protected-resource', has: open, destination: '/api/oauth/metadata?doc=prm' },
    { source: '/.well-known/oauth-authorization-server', has: open, destination: '/api/oauth/metadata?doc=as' },
    { source: '/oauth/:endpoint(authorize|token|register|revoke)', has: open, destination: '/api/oauth/:endpoint' },
    { source: '/ai/review/:id', has: open, destination: '/api/oauth/open?id=:id' },
  ]
}

/**
 * next.config.js `rewrites().fallback` entry: an /api/* path no route serves
 * goes to /__not_found/<rest> — still Next's ordinary 404, and under an
 * `rsc: 1` probe the same answer a closed AI route gives.
 */
function apiFallbackRewrite() {
  return { source: '/api/:path*', destination: `${AI_CLOSED_TARGET}/:path*` }
}

module.exports = { AI_OPEN_HEADER, AI_CLOSED_TARGET, isAiPublicPath, aiPublicRewrites, apiFallbackRewrite }
