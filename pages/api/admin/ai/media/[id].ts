import { withApi } from '../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../lib/auth'
import { getMediaFile } from '../../../../../lib/ai/media'

/**
 * One file given to the assistant (admin only; lib/ai/media):
 * GET /api/admin/ai/media/<id>[?download=1] → its bytes.
 *
 * Images play inline (the transcript's thumbnails and viewer); PDFs, text and
 * `?download=1` always download. Text is served as text/plain whatever it
 * holds, every answer under a sandboxing CSP with nosniff, so nothing in a
 * file can run here. A file is immutable under its id: cached privately.
 * A pending file is served only to the session that uploaded it.
 */

const inlineKinds = new Set(['image', 'audio'])

function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export default withApi('admin/ai/media/one', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  const file = getMediaFile(req.query.id)
  if (!file || (file.conversationId === null && file.sessionId !== ctx.session?.id)) {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(404).json({ code: 'NOT_FOUND', error: 'No such file.' })
  }
  // Immutable under its id: the browser keeps it, so no validator is needed.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  const download = req.query.download === '1' || !inlineKinds.has(file.kind)
  res.setHeader('Content-Disposition', disposition(download ? 'attachment' : 'inline', file.name))
  res.setHeader('Content-Type', file.kind === 'text' ? 'text/plain; charset=utf-8' : file.mime)
  res.setHeader('Accept-Ranges', 'bytes')
  // Safari plays audio only from a server that answers byte ranges.
  const range = typeof req.headers.range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim()) : null
  const total = file.bytes.length
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]))
    let end = range[1] && range[2] ? Number(range[2]) : total - 1
    end = Math.min(end, total - 1)
    if (!Number.isFinite(start) || start > end || start >= total) {
      res.setHeader('Content-Range', `bytes */${total}`)
      return res.status(416).end()
    }
    start = Math.max(0, start)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
    res.setHeader('Content-Length', String(end - start + 1))
    if (req.method === 'HEAD') return res.status(206).end()
    return res.status(206).end(file.bytes.subarray(start, end + 1))
  }
  res.setHeader('Content-Length', String(total))
  if (req.method === 'HEAD') return res.status(200).end()
  return res.status(200).end(file.bytes)
})
