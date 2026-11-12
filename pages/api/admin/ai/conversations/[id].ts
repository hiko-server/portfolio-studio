import { withApi } from '../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../lib/auth'
import { recordAdminAudit } from '../../../../../lib/audit/record'
import { log } from '../../../../../lib/log'
import { deleteConversation, getConversation, loadTurns, runsOf, servedBy } from '../../../../../lib/ai/conversations'
import { getProvider } from '../../../../../lib/ai/providers/keys'
import { activeRun, runView } from '../../../../../lib/ai/runs'
import { mediaSupportOf, UNKNOWN_SUPPORT } from '../../../../../lib/ai/media'

/**
 * One conversation (admin only, never cached).
 *
 *   GET    → { conversation, turns, runs, active }
 *   DELETE → { deleted }      refused while it is running (stop it first)
 *
 * Turns are their DISPLAY form only (what the admin renders). The native
 * history, the frozen system text and tool schemas stay on the server: they
 * are the provider's replay format and nothing a browser needs.
 */

export default withApi('admin/ai/conversations/one', (req, res) => {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  const conversation = getConversation(req.query.id)
  if (!conversation) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such conversation.' })
  try {
    if (req.method === 'GET') {
      const active = activeRun()
      const provider = getProvider(conversation.providerId)
      return res.status(200).json({
        conversation: {
          id: conversation.id,
          title: conversation.title,
          providerId: conversation.providerId,
          providerLabel: conversation.providerLabel,
          // The same rule a run applies: the row's wire and endpoint are still the ones it began on.
          providerAvailable: !!provider && servedBy(conversation, provider),
          wire: conversation.wire,
          model: conversation.model,
          effort: conversation.effort,
          tools: conversation.tools.length,
          chatOnly: conversation.request.chatOnly,
          tokensWeighted: conversation.tokensWeighted,
          // What files its model takes: frozen when it began, else from the model's latest Test (null: tried when sent).
          media: conversation.request.media ?? (provider ? mediaSupportOf(conversation.wire, provider.tests[conversation.model]?.observations, provider.tests[conversation.model]?.claude) : UNKNOWN_SUPPORT),
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        },
        turns: loadTurns(conversation.id).map((t) => ({ seq: t.seq, role: t.role, display: t.display, inHistory: t.native !== null, runId: t.runId, createdAt: t.createdAt })),
        runs: runsOf(conversation.id).map((r) => runView(r.id)),
        active: active && active.conversationId === conversation.id ? runView(active.id) : null,
      })
    }
    if (req.method === 'DELETE') {
      if (activeRun()?.conversationId === conversation.id) return res.status(409).json({ code: 'RUN_ACTIVE', error: 'Stop the answer being written first.' })
      const deleted = deleteConversation(conversation.id)
      if (deleted) recordAdminAudit(req, res, { action: 'ai.conversation-delete', area: 'ai', summary: 'Deleted an assistant conversation' })
      return res.status(200).json({ deleted })
    }
  } catch (err) {
    log.error('AI conversation request failed', { method: req.method, err })
    return res.status(503).json({ code: 'UNAVAILABLE', error: 'The conversation cannot be read right now.' })
  }
  res.setHeader('Allow', 'GET, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
