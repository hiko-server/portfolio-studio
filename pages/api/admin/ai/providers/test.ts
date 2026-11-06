import type { NextApiRequest, NextApiResponse, PageConfig } from 'next'
import { withApi } from '../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../lib/auth'
import { requireRecentAuth } from '../../../../../lib/adminAuth/stepUp'
import { takeMemory } from '../../../../../lib/ai/budgets'
import { quirksFor } from '../../../../../lib/ai/presets'
import { createAdapter } from '../../../../../lib/ai/providers/factory'
import { openRowKey, quirksOf, recordTest, type StoredTest } from '../../../../../lib/ai/providers/keys'
import { probeProvider } from '../../../../../lib/ai/providers/probe'
import { parseKeyShape, rememberTypedProbe, typedProbeKey } from '../../../../../lib/ai/providers/requests'
import { anthropicEnvProblem } from '../../../../../lib/ai/providers/env'
import { assistantTools } from '../../../../../lib/ai/runs'

/**
 * Test a model provider on the owner's own key (admin only; design §7.7):
 * POST with exactly one of the two shapes of lib/ai/providers/requests —
 * `{ providerId, model? }` for a saved key (opened with its own stored URL),
 * or `{ typedKey, preset, …, model }` before Save (a Custom URL needs a
 * recent verification first). Runs the real probe — the whole tool catalogue
 * plus probe_echo, then the replay — and answers its result: status, steps
 * and observations, plain text only, never the key.
 *
 * A saved key's result is stored with its row (per model). A typed key's is
 * kept on the server for ten minutes, so the Save that follows can carry it.
 * Rate-limited with Check key: 10 per 10 minutes.
 */

const PROBE_WALL_MS = 3 * 60_000

export const config: PageConfig = { api: { bodyParser: { sizeLimit: '16kb' } } }

async function test(req: NextApiRequest, res: NextApiResponse) {
  const parsed = parseKeyShape(req.body)
  if (!parsed.ok) {
    const { status, ...problem } = parsed.problem
    return res.status(status).json(problem)
  }
  const shape = parsed.shape
  if (shape.kind === 'typed' && shape.target.custom && !requireRecentAuth(req, res)) return
  const model = shape.model
  if (!model) return res.status(400).json({ code: 'INVALID', field: 'model', error: 'Choose or type a model to test.' })
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
  let effort: string | null
  if (shape.kind === 'stored') {
    const opened = openRowKey(shape.row)
    if (!opened.ok) {
      return res.status(409).json(opened.reason === 'no-secret' ? { code: 'NO_SECRET', error: 'This server cannot open stored keys: its key-encryption secret is not set.' } : { code: 'KEY_REENTER', error: 'This key has to be entered again.' })
    }
    apiKey = opened.apiKey
    baseUrl = shape.row.baseUrl
    quirks = quirksOf(shape.row)
    effort = shape.row.effort
  } else {
    apiKey = shape.apiKey
    baseUrl = shape.target.baseUrl
    quirks = quirksFor(shape.target.preset, shape.ownerQuirks)
    effort = shape.effort ?? (wire === 'anthropic' ? 'medium' : null)
  }

  const adapter = createAdapter({ wire, baseUrl, apiKey, quirks })
  const result: StoredTest = await probeProvider({
    adapter,
    wire,
    model,
    tools: assistantTools(),
    effort,
    maxOutputTokens: quirks.maxOutputTokens,
    signal: AbortSignal.timeout(PROBE_WALL_MS),
    providerId: shape.kind === 'stored' ? shape.row.id : null,
  })
  if (shape.kind === 'stored') recordTest(shape.row.id, model, result)
  else rememberTypedProbe(typedProbeKey(shape.target, shape.apiKey, model), result)
  return res.status(200).json({ model, result })
}

export default withApi(
  'admin/ai/providers/test',
  (req, res) => {
    const ctx = readAdminContext(req, res)
    if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'POST') return test(req, res)
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  },
  { longLived: true },
)
