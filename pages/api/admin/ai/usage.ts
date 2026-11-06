import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext } from '../../../../lib/auth'
import { log } from '../../../../lib/log'
import { usageByDay } from '../../../../lib/ai/conversations'
import { listProviders } from '../../../../lib/ai/providers/keys'
import { CAPS, dayUsed } from '../../../../lib/ai/runBudget'
import { readAiSettings } from '../../../../lib/ai/settings'

/**
 * The assistant's model usage (admin only, never cached; design §7.7): per
 * UTC day, provider and model over the last `days` (1–90, default 30), as
 * the providers reported it — calls whose usage was estimated (UTF-8 bytes /
 * 3) are counted — and today's weighted total against the daily limit. Cost
 * appears only where every call of a row reported it: there are no price
 * tables here.
 */

export default withApi('admin/ai/usage', (req, res) => {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const raw = typeof req.query.days === 'string' ? Number(req.query.days) : 30
  const days = Number.isInteger(raw) && raw >= 1 && raw <= 90 ? raw : 30
  try {
    const now = Date.now()
    const since = new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10)
    const labels = Object.fromEntries(listProviders().map((p) => [p.id, p.label]))
    let limit: number | null = null
    try {
      limit = readAiSettings().dailyTokenLimit
    } catch {
      limit = null
    }
    return res.status(200).json({
      days,
      rows: usageByDay(since).map((r) => ({ ...r, providerLabel: labels[r.providerId] ?? null })),
      today: { weighted: dayUsed(now), limit, resetsAt: Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000 },
      caps: { runTokens: CAPS.runTokens, conversationTokens: CAPS.conversationTokens, modelTurnsPerRun: CAPS.modelTurnsPerRun, toolCallsPerRun: CAPS.toolCallsPerRun },
    })
  } catch (err) {
    log.error('AI usage unavailable', { err })
    return res.status(503).json({ code: 'UNAVAILABLE', error: 'Usage cannot be read right now.' })
  }
})
