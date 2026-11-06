import type { NextApiRequest, NextApiResponse, PageConfig } from 'next'
import { withApi } from '../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../lib/auth'
import { requireRecentAuth } from '../../../../../lib/adminAuth/stepUp'
import { takeMemory } from '../../../../../lib/ai/budgets'
import { quirksFor } from '../../../../../lib/ai/presets'
import { anthropicEnvProblem } from '../../../../../lib/ai/providers/env'
import { createAdapter } from '../../../../../lib/ai/providers/factory'
import { openRowKey, quirksOf } from '../../../../../lib/ai/providers/keys'
import { parseKeyShape } from '../../../../../lib/ai/providers/requests'
import { ProviderError } from '../../../../../lib/ai/providers/types'

/**
 * "Check key": a provider's live model list (admin only; design §7.7).
 * POST with exactly one of the two shapes of lib/ai/providers/requests — a
 * saved key with its own stored URL, or a typed key before Save (a Custom URL
 * needs a recent verification first). The list is what the provider says
 * today: no model ids are in code, and free text always works (Z.ai has no
 * list, others vary). Rate-limited with Test: 10 per 10 minutes.
 */

export const config: PageConfig = { api: { bodyParser: { sizeLimit: '16kb' } } }

async function models(req: NextApiRequest, res: NextApiResponse) {
  const parsed = parseKeyShape(req.body)
  if (!parsed.ok) {
    const { status, ...problem } = parsed.problem
    return res.status(status).json(problem)
  }
  const shape = parsed.shape
  if (shape.kind === 'typed' && shape.target.custom && !requireRecentAuth(req, res)) return
  const wire = shape.kind === 'stored' ? shape.row.wire : shape.target.wire
  if (wire === 'anthropic') {
    const problem = anthropicEnvProblem()
    if (problem) return res.status(409).json({ code: 'PROVIDER_ENV', error: problem })
  }
  const budget = takeMemory('providerCheck', 'site')
  if (!budget.ok) {
    res.setHeader('Retry-After', String(budget.retryAfterS))
    return res.status(429).json({ code: 'RATE_LIMITED', error: `Too many checks: try again in ${budget.retryAfterS} s.`, retryAfterS: budget.retryAfterS })
  }
  let apiKey: string | null
  let baseUrl: string
  let quirks
  if (shape.kind === 'stored') {
    const opened = openRowKey(shape.row)
    if (!opened.ok) {
      return res.status(409).json(opened.reason === 'no-secret' ? { code: 'NO_SECRET', error: 'This server cannot open stored keys: its key-encryption secret is not set.' } : { code: 'KEY_REENTER', error: 'This key has to be entered again.' })
    }
    apiKey = opened.apiKey
    baseUrl = shape.row.baseUrl
    quirks = quirksOf(shape.row)
  } else {
    apiKey = shape.apiKey
    baseUrl = shape.target.baseUrl
    quirks = quirksFor(shape.target.preset, shape.ownerQuirks)
  }
  const preselect = shape.kind === 'typed' ? (shape.target.preset.preselect ?? null) : null
  try {
    const list = await createAdapter({ wire, baseUrl, apiKey, quirks }).listModels(AbortSignal.timeout(60_000))
    return res.status(200).json({
      models: list.map((m) => ({ id: m.id, label: m.label, maxOutputTokens: m.maxOutputTokens, maxInputTokens: m.maxInputTokens })),
      listed: quirks.listModels !== 'none',
      preselect: preselect && list.some((m) => m.id === preselect) ? preselect : null,
    })
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError('unknown', 'The model list could not be read.')
    const refused = e.kind === 'auth' || e.kind === 'permission'
    // A provider refusing the key is not this site's session failing: never a 401 the browser would read as a sign-out.
    const status = refused ? 422 : e.kind === 'config' || e.kind === 'blocked' ? 409 : 502
    return res.status(status).json({ code: refused ? 'KEY_REFUSED' : 'PROVIDER_ERROR', kind: e.kind, error: e.message })
  }
}

export default withApi(
  'admin/ai/providers/models',
  (req, res) => {
    const ctx = readAdminContext(req, res)
    if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'POST') return models(req, res)
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  },
  { longLived: true },
)
