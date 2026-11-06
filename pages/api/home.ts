import type { NextApiRequest, NextApiResponse } from 'next'
import { readHome, readPublicHome, saveHomeSnapshot, listHomeSnapshots, readHomeSnapshot } from '../../lib/home'
import { attachmentDisposition, kvEtag, safeSnapshotName } from '../../lib/contentStore'
import { rateLimit } from '../../lib/rateLimit'
import { isAdminRequest } from '../../lib/auth'
import { sendVersionedJson } from '../../lib/http'
import { HOME_STATIC_PATHS, refreshHome } from '../../lib/contentOps/refresh'
import { restoreHomeDoc, saveHomeDoc } from '../../lib/contentOps/home'
import { ownerMail } from '../../lib/contentOps/notify'
import { withApi } from '../../lib/apiHandler'

const isAuthed = isAdminRequest

/**
 * /api/home
 *
 *   GET                    public view (publicHome) for everyone — admin
 *                          editors load GET /api/admin/home
 *   GET ?snapshots=1       admin: snapshot file list
 *   GET ?download=1[&file] admin: download the full document or a snapshot
 *   PUT                    admin: save the full document; honours If-Match.
 *                          Availability, open-source picks, the site name
 *                          and logo scales are validated and normalised
 *                          (lib/homeShape normalizeHomeWrite): 422
 *                          {code:'INVALID_HOME', error, errors} on bad input.
 *                          Brand logos are measured for optical sizing
 *                          (lib/logoMetrics withLogoMetrics: new or changed
 *                          images only; stored as brands[].metrics)
 *   POST {action}          admin: snapshot / restore
 *
 * The save and the restore live in lib/contentOps/home, which an approved
 * AI proposal uses too; this route adds the session, the rate limit and the
 * page regeneration.
 */

/**
 * The ISR pages that render home data, regenerated after a save or restore
 * (lib/contentOps/refresh refreshHome, which also re-renders the PDF CVs).
 */
export { HOME_STATIC_PATHS }

function sendConflict(res: NextApiResponse, version: number) {
  const etag = kvEtag(version)
  return sendVersionedJson(res, 409, {
    error: 'conflict',
    message: 'The home page was changed elsewhere since you loaded it. Reload to get the latest version, then re-apply your edits.',
    etag,
  }, etag)
}

export default withApi('home', async (req: NextApiRequest, res: NextApiResponse, ctx) => {
  if (req.method === 'GET') {
    // List home snapshots
    if (req.query.snapshots === '1') {
      if (!isAuthed(req, res)) return res.status(401).json({ error: 'Unauthorized' })
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json({ files: listHomeSnapshots() })
    }
    // Download the current document or a specific snapshot
    if (req.query.download !== undefined) {
      if (!isAuthed(req, res)) return res.status(401).json({ error: 'Unauthorized' })
      res.setHeader('Cache-Control', 'no-store')
      const fileParam = req.query.file
      if (fileParam !== undefined && fileParam !== '') {
        const file = safeSnapshotName(fileParam)
        if (!file) return res.status(400).json({ error: 'Invalid file name' })
        const raw = readHomeSnapshot(file)
        if (raw === null) return res.status(404).json({ error: 'Not found' })
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Disposition', attachmentDisposition(file))
        return res.status(200).send(raw)
      }
      const data = readHome()
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', attachmentDisposition('home.json'))
      return res.status(200).send(JSON.stringify(data, null, 2))
    }
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Home-View', 'public')
    return res.status(200).json(readPublicHome())
  }

  if (req.method === 'PUT') {
    if (!isAuthed(req, res)) return res.status(401).json({ error: 'Unauthorized' })
    res.setHeader('Cache-Control', 'no-store')
    const rl = rateLimit(req, 30, 10 * 60 * 1000)
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
    if (!rl.allowed) return res.status(429).json({ error: 'Too many updates, try later' })
    const out = await saveHomeDoc(req.body, { ifMatch: req.headers['if-match'] }, { log: ctx.log, notify: ownerMail(ctx.log) })
    if (!out.ok) {
      if (out.code === 'CONFLICT') return sendConflict(res, out.version)
      if (out.code === 'INVALID_HOME') return res.status(422).json({ code: out.code, error: out.error, errors: out.errors })
      return res.status(out.status).json({ error: out.error })
    }
    // Nothing changed: no snapshot, no write, version (ETag) unchanged.
    if (out.unchanged) return sendVersionedJson(res, 200, { ok: true, unchanged: true, etag: out.etag }, out.etag)
    const revalidation = await refreshHome(res)
    return sendVersionedJson(res, 200, {
      ok: true,
      etag: out.etag,
      ...(out.r2Warning ? { r2Warning: out.r2Warning } : {}),
      ...revalidation,
    }, out.etag)
  }

  if (req.method === 'POST') {
    if (!isAuthed(req, res)) return res.status(401).json({ error: 'Unauthorized' })
    res.setHeader('Cache-Control', 'no-store')
    const { action, filename } = req.body || {}
    if (action === 'snapshot') {
      const file = saveHomeSnapshot()
      return res.status(200).json({ ok: true, file })
    }
    if (action === 'restore') {
      const result = await restoreHomeDoc(filename, {}, { log: ctx.log })
      if (!result.ok) return res.status(result.status).json({ error: result.error })
      const revalidation = await refreshHome(res)
      return sendVersionedJson(res, 200, {
        ok: true,
        etag: result.etag,
        ...(result.r2Warning ? { r2Warning: result.r2Warning } : {}),
        ...revalidation,
      }, result.etag)
    }
    return res.status(400).json({ error: 'Unknown action' })
  }

  res.setHeader('Allow', 'GET,PUT,POST')
  return res.status(405).json({ error: 'Method not allowed' })
})
