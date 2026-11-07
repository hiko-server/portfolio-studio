import type { NextApiRequest, NextApiResponse, PageConfig } from 'next'
import { withApi } from '../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../lib/auth'
import { cleanModel } from '../../../../../lib/ai/providers/keys'
import { activeRun, MESSAGE_MAX, pipeRun, runView, startRun } from '../../../../../lib/ai/runs'
import { parseAttachments } from '../../../../../lib/ai/attachments'

/**
 * The assistant (admin only; design §7.5, §7.7).
 *
 *   GET                                   → { active: RunView | null }
 *   POST { conversationId?, message?, continue?, attachments?, providerId?, model? }
 *        → text/event-stream: the run's events (run, text, thinking,
 *          tool_start, tool_end, change, notice, usage, turn, ping,
 *          run_end), each with a monotonically increasing seq;
 *          or JSON 4xx when the run cannot start (RUN_ACTIVE names the run).
 *
 * The run lives on the server: this response is only a view of it. Closing
 * the tab does not cancel anything (POST runs/[id]/stop does); GET
 * runs/[id]/events?after=<seq> picks up where a view left off. JSON body,
 * capped at 720 KB (a message and, from an open editor, its state: lib/ai/
 * attachments); the proxy's CSRF and media-type rules apply as to every
 * admin write.
 */

// A message (100,000 characters) plus, from an open editor, its body (256 KiB) and fields (64 KiB).
export const config: PageConfig = { api: { bodyParser: { sizeLimit: '720kb' }, responseLimit: false } }

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

async function start(req: NextApiRequest, res: NextApiResponse) {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  // A run is bound to this browser's session row: the session ending stops it.
  if (!ctx.session) return res.status(409).json({ code: 'NO_SESSION_ROW', error: 'Reload the page and try again.' })
  const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null) as Record<string, unknown> | null
  if (!b) return res.status(400).json({ code: 'INVALID', error: 'Send a JSON object.' })
  for (const k of Object.keys(b)) {
    if (!['conversationId', 'message', 'continue', 'attachments', 'providerId', 'model'].includes(k)) return res.status(400).json({ code: 'INVALID', field: k, error: `Unknown field: ${k}.` })
  }
  if (b.message !== undefined && b.message !== null && typeof b.message !== 'string') return res.status(400).json({ code: 'INVALID', field: 'message', error: 'The message is text.' })
  if (typeof b.message === 'string' && b.message.length > MESSAGE_MAX) return res.status(400).json({ code: 'INVALID', field: 'message', error: 'This message is too long.' })
  if (b.continue !== undefined && typeof b.continue !== 'boolean') return res.status(400).json({ code: 'INVALID', field: 'continue', error: 'continue is true or false.' })
  const attachments = parseAttachments(b.attachments)
  if (!attachments.ok) return res.status(400).json({ code: 'INVALID', field: 'attachments', error: attachments.error })
  // The model a new conversation freezes: the providers routes' rule (≤ 200 characters, no whitespace or control character).
  const model = cleanModel(b.model)
  if (model === undefined && b.model !== undefined) return res.status(400).json({ code: 'INVALID', field: 'model', error: 'Not a model name.' })

  const started = await startRun({
    session: { id: ctx.session.id, ipPrefix: ctx.session.ipPrefix, country: ctx.session.country },
    conversationId: str(b.conversationId),
    providerId: str(b.providerId),
    model: model ?? null,
    message: typeof b.message === 'string' ? b.message : null,
    continue: b.continue === true,
    attachments: attachments.list,
    editor: attachments.editor,
    selection: attachments.selection,
  })
  if (!started.ok) {
    const { ok: _ok, status, ...body } = started
    void _ok
    return res.status(status).json(body)
  }
  await pipeRun(res, started.run.id, 0)
}

export default withApi(
  'admin/ai/runs',
  async (req, res) => {
    const ctx = readAdminContext(req, res)
    if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'GET') {
      const active = activeRun()
      return res.status(200).json({ active: active ? runView(active.id) : null })
    }
    if (req.method === 'POST') return start(req, res)
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Method not allowed' })
  },
  { longLived: true },
)
