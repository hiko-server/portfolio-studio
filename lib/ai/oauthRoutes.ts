import type { NextApiRequest, NextApiResponse } from 'next'
import { recordAuthEvent } from '../adminAuth/store'
import { getSession } from '../adminAuth/sessions'
import { cleanAuditEntry } from '../audit/record'
import { recordAudit } from '../audit/store'
import { getPublicHost } from '../env'
import { log } from '../log'
import { clientKey, rateLimitNetwork } from '../rateLimit'
import { forwardedScheme } from '../security/forwardedScheme'
import { requestNetwork } from '../mcp/http'
import type { Grant } from './access'
import { MEMORY_BUDGETS, takeMemory, type MemoryBudget } from './budgets'

/**
 * The HTTP side the public OAuth routes share (SERVER-ONLY): reading a capped
 * raw body, OAuth error answers, the per-network budgets, the plain-http
 * refusal, and how a grant made or ended through them is recorded — in the
 * Security history (auth events, under the browser session that allowed it)
 * and in Activity (area `ai`). These routes have no admin session, so the
 * records name the browser that consented, never the app's request.
 */

/** Read the body up to `max` bytes; null when it is larger (reading stops there). */
export async function readRawBody(req: NextApiRequest, max: number): Promise<Buffer | null> {
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

export const isFormBody = (type: string | string[] | undefined) => /^application\/x-www-form-urlencoded\s*(;|$)/i.test(String(Array.isArray(type) ? type[0] : type || '').trim())
export const isJsonBody = (type: string | string[] | undefined) => /^application\/json\s*(;|$)/i.test(String(Array.isArray(type) ? type[0] : type || '').trim())

/** An OAuth error answer (RFC 6749 §5.2 shape): never cached. */
export function oauthError(res: NextApiResponse, status: number, error: string, description: string): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  res.status(status).json({ error, error_description: description })
}

/**
 * Spend one request of an OAuth route's budget for this client (its IPv4
 * address or IPv6 /64) and its IPv6 /48. Returns the seconds to wait when
 * either is spent, else null.
 */
export function spendOAuthBudget(req: NextApiRequest, budget: Extract<MemoryBudget, 'oauthPerNetwork' | 'registerPerNetwork'>, scope: string): number | null {
  const rule = MEMORY_BUDGETS[budget]
  const spent = takeMemory(budget, `${scope}|${clientKey(req)}`)
  if (!spent.ok) return spent.retryAfterS
  const network = rateLimitNetwork(req, rule.limit, rule.windowMs, `oauth-${scope}`)
  if (!network.allowed) return Math.max(1, Math.ceil((network.resetAt - Date.now()) / 1000))
  return null
}

/** A POST over plain http while the site has a public host: a POST is never redirected, so refuse it (§6.3 step 3). */
export function plainHttpRefused(req: NextApiRequest): boolean {
  return !!getPublicHost() && forwardedScheme(req.headers) === 'http'
}

const LEVEL_NAMES = ['Read published', 'Read and draft', 'Read, draft and propose']
const levelOf = (g: Grant) => LEVEL_NAMES[Math.min(LEVEL_NAMES.length, g.scopes.length) - 1] || g.scopes.join(' ')

/** Record a public OAuth route's event: one Activity row (area `ai`) and one Security history line, under the browser that allowed the grant. */
function record(req: NextApiRequest, res: NextApiResponse, grant: Grant, entry: { action: string; summary: string; authType: 'ai-token-created' | 'ai-apps-ended'; detail: string }, route: string): void {
  const session = grant.createdSession ? getSession(grant.createdSession) : null
  const device = session?.device ?? grant.createdDevice
  try {
    const clean = cleanAuditEntry({ action: entry.action, area: 'ai', target: grant.name, summary: entry.summary })
    if (clean) {
      const requestId = res.getHeader('X-Request-Id')
      recordAudit({
        ...clean,
        sessionId: grant.createdSession,
        device,
        ...requestNetwork(req),
        method: 'POST',
        route,
        status: 200,
        requestId: typeof requestId === 'string' ? requestId : null,
      })
    }
  } catch (err) {
    log.warn('activity log: OAuth event not recorded', { action: entry.action, err })
  }
  try {
    recordAuthEvent({ type: entry.authType, sessionId: grant.createdSession, device, ...requestNetwork(req), detail: entry.detail })
  } catch (err) {
    log.warn('sign-in history: OAuth event not recorded', { action: entry.action, err })
  }
}

/** A grant made by a code exchange. */
export function recordGrantMade(req: NextApiRequest, res: NextApiResponse, grant: Grant): void {
  record(
    req,
    res,
    grant,
    {
      action: 'ai.oauth-connect',
      summary: `Connected an app over OAuth (${levelOf(grant)})`,
      authType: 'ai-token-created',
      detail: `“${grant.name}” over OAuth, ${grant.scopes.join(' ')}, returns to ${grant.redirectHost ?? 'unknown'}`,
    },
    'oauth/token',
  )
}

/** A grant ended through a public route: a used code or refresh token came back, or the app revoked its own token. */
export function recordGrantEnded(req: NextApiRequest, res: NextApiResponse, grant: Grant, why: 'code-replay' | 'refresh-reuse' | 'app-revoked'): void {
  const text = {
    'code-replay': { summary: 'Ended an OAuth app: its authorization code was used twice', detail: 'authorization code used twice' },
    'refresh-reuse': { summary: 'Ended an OAuth app: a used refresh token came back', detail: 'refresh token used twice' },
    'app-revoked': { summary: 'An OAuth app disconnected itself', detail: 'revoked by the app' },
  }[why]
  record(req, res, grant, { action: why === 'app-revoked' ? 'ai.oauth-revoke' : 'ai.oauth-replay', summary: text.summary, authType: 'ai-apps-ended', detail: `“${grant.name}” ${text.detail}` }, why === 'app-revoked' ? 'oauth/revoke' : 'oauth/token')
}
