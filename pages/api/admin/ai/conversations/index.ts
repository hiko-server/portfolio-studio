import { withApi } from '../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../lib/auth'
import { recordAdminAudit } from '../../../../../lib/audit/record'
import { log } from '../../../../../lib/log'
import { deleteConversation, listConversations } from '../../../../../lib/ai/conversations'
import { activeRun, runView } from '../../../../../lib/ai/runs'
import { readAiSettings } from '../../../../../lib/ai/settings'

/**
 * The assistant's conversations (admin only, never cached; design §3.2).
 *
 *   GET    ?before=<ms>   → { conversations, active, keepDays }   newest first, 100 at a time
 *   DELETE { all: true }  → { deleted }                           every conversation but a running one
 *
 * Conversations hold draft text, so they stay on this server only (never in
 * a backup or R2) and go after `keep_conversations_days` (90 by default).
 */

export default withApi('admin/ai/conversations', (req, res) => {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method === 'GET') {
      const before = typeof req.query.before === 'string' && /^\d{1,15}$/.test(req.query.before) ? Number(req.query.before) : undefined
      const active = activeRun()
      let keepDays: number | null = null
      try {
        keepDays = readAiSettings().keepConversationsDays
      } catch {
        keepDays = null
      }
      return res.status(200).json({ conversations: listConversations(100, before), active: active ? runView(active.id) : null, keepDays })
    }
    if (req.method === 'DELETE') {
      const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
      if (b.all !== true) return res.status(400).json({ code: 'INVALID', error: 'Send { all: true }, or delete one conversation at its own address.' })
      const running = activeRun()?.conversationId ?? null
      let deleted = 0
      for (let page = listConversations(500); page.length; page = listConversations(500)) {
        const doomed = page.filter((c) => c.id !== running)
        for (const c of doomed) if (deleteConversation(c.id)) deleted++
        if (doomed.length < page.length || page.length < 500) break
      }
      recordAdminAudit(req, res, { action: 'ai.conversations-delete', area: 'ai', summary: `Deleted ${deleted === 1 ? 'an assistant conversation' : `${deleted} assistant conversations`}` })
      return res.status(200).json({ deleted })
    }
  } catch (err) {
    log.error('AI conversations request failed', { method: req.method, err })
    return res.status(503).json({ code: 'UNAVAILABLE', error: 'The conversations cannot be read right now.' })
  }
  res.setHeader('Allow', 'GET, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
