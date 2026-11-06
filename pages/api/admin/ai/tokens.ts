import type { NextApiRequest, NextApiResponse } from 'next'
import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext, requestOrigin, type AdminContext } from '../../../../lib/auth'
import { requireFreshAuth } from '../../../../lib/adminAuth/stepUp'
import { recordAuthEvent } from '../../../../lib/adminAuth/store'
import { recordAdminAudit } from '../../../../lib/audit/record'
import { log } from '../../../../lib/log'
import { ACCESS_LEVELS, PAT_DEFAULT_DAYS, PAT_LIFETIME_DAYS, createPersonalToken, getGrant, renameGrant, revokeGrant, revokeGrants } from '../../../../lib/ai/access'
import { aiAlert } from '../../../../lib/ai/alerts'
import { voidOpenChanges } from '../../../../lib/ai/changes'
import { accessState, appViews } from '../../../../lib/ai/summary'
import { canonicalResource } from '../../../../lib/mcp/http'

/**
 * Connected apps: personal tokens and every live grant (admin only, never
 * cached; design §5.4).
 *
 *   GET                          → { apps, lifetimes, defaultDays, levels }
 *   POST   { name, level, days } → 201 { token, app }      the token, once
 *   PATCH  { id, name }          → { app }                 rename
 *   DELETE { id }                → { ended: 1 }            revoke one
 *   DELETE { all: true }         → { ended: n }            revoke every one
 *
 * Making a token is a new way into the content for something other than this
 * browser, so it needs a verification within the last 2 minutes
 * (requireFreshAuth), and AI access with connected apps allowed (a token for
 * a closed endpoint would only fail later). Its audience is the canonical MCP
 * address from SITE_URL, never the Host header. The token is in this one
 * response and nowhere else: the store keeps its SHA-256, the logs never see
 * it. Revoking needs no verification (reducing access has no friction), works
 * on the next request, and withdraws what the app still had waiting.
 */

/** How recently the owner must have verified to make a token (§5.2). */
const FRESH_MS = 120_000

function levelScopes(level: unknown): string[] | null {
  return typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= ACCESS_LEVELS.length ? [...ACCESS_LEVELS[level - 1]] : null
}

function oneApp(ctx: AdminContext, id: string) {
  return appViews(ctx.session?.id ?? null).find((a) => a.id === id) ?? null
}

function voidFor(ids: string[]): void {
  if (!ids.length) return
  try {
    voidOpenChanges({ actorIds: ids }, 'ISSUER_ENDED')
  } catch (err) {
    log.error('AI changes of a revoked app could not be withdrawn', { err })
  }
}

function create(req: NextApiRequest, res: NextApiResponse) {
  const ctx = requireFreshAuth(req, res, FRESH_MS)
  if (!ctx) return
  const state = accessState()
  if (!state.enabled || state.blocked || !state.mcpEnabled) {
    return res.status(409).json({ code: 'APPS_OFF', error: 'Turn on AI access and allow connected apps first.' })
  }
  const resource = canonicalResource()
  if (!resource) return res.status(409).json({ code: 'NO_SITE_URL', error: 'SITE_URL is not set on the server, so there is no address a token could be for.' })
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
  const scopes = levelScopes(body.level)
  if (!scopes) return res.status(400).json({ code: 'INVALID', field: 'level', error: 'Choose an access level.' })
  const origin = requestOrigin(req)
  const made = createPersonalToken(
    { name: body.name, scopes, days: body.days, resource, session: { id: ctx.session?.id ?? null, device: ctx.session?.device ?? origin.device } },
    { onEvent: aiAlert },
  )
  if (!made.ok) {
    if (made.code === 'NO_SECRET') return res.status(503).json({ code: 'NO_SECRET', error: 'The server has no JWT_SECRET, so it cannot make tokens.' })
    const message = made.field === 'name' ? 'Give the token a name.' : made.field === 'days' ? 'Choose 7, 30, 90 or 365 days.' : 'Choose an access level.'
    return res.status(400).json({ code: 'INVALID', field: made.field, error: message })
  }
  const level = scopes.length
  recordAdminAudit(req, res, { action: 'ai.token-create', area: 'ai', target: `level ${level}`, summary: 'Created a personal token for a connected app' })
  recordAuthEvent({ type: 'ai-token-created', sessionId: ctx.session?.id ?? null, detail: `“${made.grant.name}”, ${made.grant.scopes.join(' ')}, ${body.days} days`, ...origin })
  return res.status(201).json({ token: made.token, app: oneApp(ctx, made.grant.id) })
}

function rename(req: NextApiRequest, res: NextApiResponse, ctx: AdminContext) {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
  if (typeof body.id !== 'string') return res.status(400).json({ code: 'INVALID', field: 'id', error: 'Send { id, name }.' })
  const grant = getGrant(body.id)
  if (!grant || grant.revokedAt !== null) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such app, or it was revoked.' })
  const renamed = renameGrant(body.id, body.name)
  if (!renamed) return res.status(400).json({ code: 'INVALID', field: 'name', error: 'Give it a name.' })
  recordAdminAudit(req, res, { action: 'ai.app-rename', area: 'ai', summary: 'Renamed a connected app' })
  return res.status(200).json({ app: oneApp(ctx, renamed.id) })
}

function revoke(req: NextApiRequest, res: NextApiResponse, ctx: AdminContext) {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>
  const origin = requestOrigin(req)
  const sessionId = ctx.session?.id ?? null
  if (body.all === true) {
    const ended = revokeGrants({ all: true }, 'revoked by the owner')
    voidFor(ended)
    if (ended.length) {
      recordAdminAudit(req, res, { action: 'ai.app-revoke-all', area: 'ai', target: String(ended.length), summary: `Revoked every connected app (${ended.length})` })
      recordAuthEvent({ type: 'ai-apps-ended', sessionId, detail: `${ended.length} revoked`, ...origin })
    }
    return res.status(200).json({ ended: ended.length })
  }
  if (typeof body.id !== 'string') return res.status(400).json({ code: 'INVALID', error: 'Send { id } or { all: true }.' })
  const grant = getGrant(body.id)
  if (!grant || !revokeGrant(grant.id, 'revoked by the owner')) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such app, or it was already revoked.' })
  voidFor([grant.id])
  recordAdminAudit(req, res, { action: 'ai.app-revoke', area: 'ai', summary: 'Revoked a connected app' })
  recordAuthEvent({ type: 'ai-apps-ended', sessionId, detail: `“${grant.name}” revoked`, ...origin })
  return res.status(200).json({ ended: 1 })
}

export default withApi('admin/ai/tokens', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'POST') return create(req, res)
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  if (req.method === 'GET') {
    return res.status(200).json({
      apps: appViews(ctx.session?.id ?? null),
      lifetimes: [...PAT_LIFETIME_DAYS],
      defaultDays: PAT_DEFAULT_DAYS,
      levels: ACCESS_LEVELS.map((scopes, i) => ({ level: i + 1, scopes: [...scopes] })),
    })
  }
  if (req.method === 'PATCH') return rename(req, res, ctx)
  if (req.method === 'DELETE') return revoke(req, res, ctx)
  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
