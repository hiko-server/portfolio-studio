import type { NextApiRequest, NextApiResponse, PageConfig } from 'next'
import { withApi, type ApiContext } from '../../lib/apiHandler'
import { getPublicHost } from '../../lib/env'
import { bearerTokenOf } from '../../lib/security/bearer'
import { forwardedScheme } from '../../lib/security/forwardedScheme'
import { touchGrant, verifyBearerToken, type Grant } from '../../lib/ai/access'
import { aiAlert } from '../../lib/ai/alerts'
import { chargeFailedAuth, failedAuthBlocked, takeMemory } from '../../lib/ai/budgets'
import { recordRefusedToken } from '../../lib/ai/execute'
import { toolByName } from '../../lib/ai/registry'
import { scrubbingLogger } from '../../lib/ai/scrub'
import { aiPublicOpen, isLocalOnly } from '../../lib/ai/settings'
import { bearerChallenge, canonicalResource, hostMatches, originAllowed, requestNetwork, resourceMetadataUrl, siteUrl } from '../../lib/mcp/http'

/**
 * The MCP endpoint (design §6.3): public at /mcp (a rewrite that exists only
 * while AI access and connected apps are on, lib/aiPublicRoutes.js), also at
 * /api/mcp. Streamable HTTP, both protocol eras, JSON responses
 * (lib/mcp/server). Bearer tokens only (lib/ai/access): the admin cookie is
 * never read here, and the route sits outside the CSRF guard because nothing
 * here acts on a cookie.
 *
 * In this order, each answering before anything later runs:
 *    1. not POST: 405 with Allow (before routing: the raw legacy transport
 *       would answer GET and DELETE);
 *    2. AI access closed: a bare 404 (the proxy already answers like an
 *       unknown path; this is defence in depth);
 *    3. plain http while the site has a public host: 403 (a POST is never
 *       redirected, so it would be served over http);
 *    4. Host other than SITE_URL's host and port: 403;
 *    5. an Origin that is neither the site's nor a known AI client's: 403;
 *    6. a client blocked by earlier failed authentication: 429;
 *    7. the bearer token: missing 401; invalid, expired, revoked, another
 *       resource: 401, charged to the failed-authentication budget (only
 *       failures spend it), and recorded when the token was made here;
 *    8. the grant's request budget: 429;
 *    9. the body, read only now: over 512 KB 413, not JSON 415, bad JSON 400;
 *   10. a JSON-RPC batch (an array): 400 — it would skip the scope gate and
 *       the request budget in the SDK's legacy transport;
 *   11. tools/call of a tool whose scope the grant lacks: 403
 *       insufficient_scope, decided from the body (anything a tool returns
 *       is a 200);
 *   12. the SDK (lib/mcp/server), with the verified grant on `req.auth`.
 *
 * Every answer is no-store. The Authorization header is never logged.
 */

export const config: PageConfig = { api: { bodyParser: false, responseLimit: false, externalResolver: true } }

/** The body cap: the route's is the only one (the SDK's bound does not apply to a parsed body). */
export const MCP_BODY_MAX = 512 * 1024

type RpcBody = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, any> } | null

function rpcError(res: NextApiResponse, status: number, code: number, message: string, id: unknown = null) {
  res.status(status).json({ jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code, message } })
}

function tooMany(res: NextApiResponse, retryAfterS: number) {
  res.setHeader('Retry-After', String(retryAfterS))
  rpcError(res, 429, -32000, `Too many requests: try again in ${retryAfterS} s.`)
}

/** Read the body up to `max` bytes; null when it is larger (reading stops there). */
async function readBody(req: NextApiRequest, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > max) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

const isJson = (type: string | undefined) => /^application\/json\s*(;|$)/i.test((type || '').trim())

/** The client's self-reported name: legacy `initialize` params, or the modern request envelope. Shown only as "says it is". */
function clientReported(body: RpcBody): string | null {
  const p = body?.params
  if (!p || typeof p !== 'object') return null
  const name = body?.method === 'initialize' ? p.clientInfo?.name : p._meta?.['io.modelcontextprotocol/clientInfo']?.name
  return typeof name === 'string' ? name : null
}

async function handler(req: NextApiRequest, res: NextApiResponse, ctx: ApiContext) {
  res.setHeader('Cache-Control', 'no-store')
  // 1.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return rpcError(res, 405, -32000, 'Method not allowed: MCP takes POST.')
  }
  // 2.
  if (!aiPublicOpen()) return res.status(404).end()
  const site = siteUrl()
  const resource = canonicalResource()
  const metadata = resourceMetadataUrl()
  if (!site || !resource || !metadata) return res.status(404).end()
  // 3.
  if (getPublicHost() && forwardedScheme(req.headers) === 'http') return rpcError(res, 403, -32000, 'Use https.')
  // 4. Never checkCsrf, which a rebound name passes (THREATS F1).
  if (!hostMatches(req.headers.host, site)) {
    return rpcError(res, 403, -32000, isLocalOnly() ? `Wrong address for this server. Use ${resource}` : 'Wrong address for this server.')
  }
  // 5.
  const origin = req.headers.origin
  if (origin !== undefined && !originAllowed(String(origin), site)) {
    ctx.log.warn('MCP request refused: Origin not allowed', { origin: String(origin).slice(0, 200) })
    return rpcError(res, 403, -32000, 'Origin not allowed.')
  }
  // 6.
  const blocked = failedAuthBlocked(req)
  if (!blocked.ok) return tooMany(res, blocked.retryAfterS)
  // 7. The header only: a token in the query string is never read.
  const token = bearerTokenOf(req.headers.authorization)
  if (!token) {
    res.setHeader('WWW-Authenticate', bearerChallenge({ scope: 'content:read', resourceMetadata: metadata }))
    return res.status(401).json({ error: 'unauthorized', error_description: 'This server needs a bearer token (Authorization: Bearer ...).' })
  }
  const network = requestNetwork(req)
  const verdict = verifyBearerToken(token, { resource })
  if (!verdict.ok) {
    chargeFailedAuth(req)
    if (verdict.validTag) {
      recordRefusedToken({ grant: verdict.grant, reason: verdict.reason, origin: network, era: null, requestId: ctx.requestId })
      if (verdict.grant) aiAlert({ type: 'refused-token', grantId: verdict.grant.id, label: verdict.grant.name, reason: verdict.reason })
    }
    res.setHeader('WWW-Authenticate', bearerChallenge({ error: 'invalid_token', description: 'The token is invalid, expired or revoked.', resourceMetadata: metadata }))
    return res.status(401).json({ error: 'invalid_token', error_description: 'The token is invalid, expired or revoked.' })
  }
  const grant: Grant = verdict.grant
  // 8.
  for (const budget of ['mcpPerGrantMinute', 'mcpPerGrantHour'] as const) {
    const spent = takeMemory(budget, grant.id)
    if (!spent.ok) return tooMany(res, spent.retryAfterS)
  }
  // 9.
  if (!isJson(req.headers['content-type'])) return rpcError(res, 415, -32000, 'Content-Type must be application/json.')
  const raw = await readBody(req, MCP_BODY_MAX)
  if (raw === null) {
    res.setHeader('Connection', 'close')
    return rpcError(res, 413, -32000, `Request body too large (at most ${MCP_BODY_MAX} bytes).`)
  }
  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return rpcError(res, 400, -32700, 'Parse error')
  }
  // 10.
  if (Array.isArray(body)) return rpcError(res, 400, -32600, 'Batches are not supported: send one request per POST.')
  const rpc = (body && typeof body === 'object' ? body : null) as RpcBody
  // 11. From the body, never the Mcp-Name header.
  if (rpc?.method === 'tools/call') {
    const tool = toolByName(rpc.params?.name)
    if (tool && !grant.scopes.includes(tool.scope)) {
      const scope = Array.from(new Set([...grant.scopes, tool.scope])).join(' ')
      res.setHeader('WWW-Authenticate', bearerChallenge({ error: 'insufficient_scope', scope, description: `${tool.name} needs ${tool.scope}.`, resourceMetadata: metadata }))
      return res.status(403).json({ error: 'insufficient_scope', error_description: `${tool.name} needs the ${tool.scope} scope, which this connection does not have.`, scope })
    }
  }
  // 12.
  touchGrant(grant, { ...network, clientReported: clientReported(rpc) }, { onEvent: aiAlert })
  const authed = req as NextApiRequest & { auth?: unknown }
  authed.auth = {
    token,
    clientId: grant.id,
    scopes: grant.scopes,
    resource: new URL(resource),
    extra: {
      facts: {
        actor: { kind: 'mcp', grantId: grant.id, label: grant.name },
        origin: network,
        requestId: ctx.requestId,
        log: scrubbingLogger(ctx.log, () => [token]),
      },
    },
  }
  const { mcpNode } = await import('../../lib/mcp/server')
  await mcpNode(req as never, res as never, body)
}

export default withApi('mcp', handler, { longLived: true })
