import type { NextApiRequest, NextApiResponse, PageConfig } from 'next'
import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext } from '../../../../lib/auth'
import { log } from '../../../../lib/log'
import { rateLimit } from '../../../../lib/rateLimit'
import { ImageQueueFullError } from '../../../../lib/imageJobs'
import { decodeUploadBody, deletePendingMedia, MediaRejected, parseMedia, storePendingMedia } from '../../../../lib/ai/media'
import { aiAccess } from '../../../../lib/ai/settings'

/**
 * A file for the assistant (admin only; lib/ai/media).
 *
 *   POST   { filename, dataUrl }   → 201 { media: MediaView }
 *   DELETE { id }                  → { deleted }   (a pending file taken out of the message box)
 *
 * The file is checked by what its bytes are (image, PDF, UTF-8 text, WAV /
 * MP3), an image is re-encoded without metadata, and it waits — bound to this
 * browser session — until a message claims it (POST runs { media: [ids] }).
 * Files nobody sends are deleted after a day. JSON like every admin write
 * (the proxy refuses form bodies); the data URL is at most ~22 MB (a 16 MB
 * PDF in base64).
 */

export const config: PageConfig = { api: { bodyParser: { sizeLimit: '23mb' } } }

async function upload(req: NextApiRequest, res: NextApiResponse, sessionId: string) {
  const rl = rateLimit(req, 80, 10 * 60_000, 'admin-ai-uploads')
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))))
    return res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many files in a short time. Try again in a few minutes.' })
  }
  try {
    const { filename, declared, buf } = decodeUploadBody(req.body)
    const parsed = await parseMedia(filename, declared, buf)
    const media = storePendingMedia(parsed, sessionId)
    return res.status(201).json({ media })
  } catch (err) {
    if (err instanceof MediaRejected) return res.status(err.status).json({ code: err.code, error: err.message })
    if (err instanceof ImageQueueFullError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds))
      return res.status(503).json({ code: 'BUSY', error: err.message })
    }
    log.error('AI upload failed', { err })
    return res.status(500).json({ code: 'FAILED', error: 'The file could not be stored.' })
  }
}

export default withApi('admin/ai/uploads', async (req, res) => {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  // A pending file is bound to this browser's session row (a message from it claims the file).
  if (!ctx.session) return res.status(409).json({ code: 'NO_SESSION_ROW', error: 'Reload the page and try again.' })
  if (req.method === 'POST') {
    if (!aiAccess().on) return res.status(409).json({ code: 'ACCESS_OFF', error: 'AI access is turned off.' })
    return upload(req, res, ctx.session.id)
  }
  if (req.method === 'DELETE') {
    const id = req.body && typeof req.body === 'object' && typeof (req.body as Record<string, unknown>).id === 'string' ? ((req.body as Record<string, unknown>).id as string) : ''
    return res.status(200).json({ deleted: deletePendingMedia(id, ctx.session.id) })
  }
  res.setHeader('Allow', 'POST, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
