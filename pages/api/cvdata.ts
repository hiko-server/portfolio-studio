import type { NextApiRequest, NextApiResponse } from 'next'
import { readCvData, readPublicCvData, writeCvData, syncLanguage, saveSnapshot, listSnapshots, readSnapshot } from '../../lib/cvdata'
import { attachmentDisposition, kvEtag, safeSnapshotName } from '../../lib/contentStore'
import { rateLimit } from '../../lib/rateLimit'
import { isAdminRequest, readAdminClaims } from '../../lib/auth'
import { sendVersionedJson } from '../../lib/http'
import { CV_STATIC_PATHS, refreshCv } from '../../lib/contentOps/refresh'
import { invalidCvMessage, isSectionArray, parseLoose, restoreCvDoc, saveCvDoc, snapshotCvQuietly } from '../../lib/contentOps/cv'
import { ownerMail } from '../../lib/contentOps/notify'
import { trackPublicationsNav } from '../../lib/publicationsNav'
import { validateCvDoc, type CvValidationError } from '../../lib/cvValidate'
import { withBareOrcid } from '../../lib/orcid/id'
import { reconcileOrcidAuth } from '../../lib/orcid/connection'
import { withEntryUids, withSectionUidsBeside } from '../../lib/cvEntryUid'
import { withApi } from '../../lib/apiHandler'

const isAuthed = isAdminRequest

/**
 * /api/cvdata
 *
 *   GET                    public view {en, zh} — ALWAYS pruned, even for an
 *                          admin (editors load GET /api/admin/cvdata)
 *   GET ?snapshots=1       admin: snapshot file list
 *   GET ?download=1[&file] admin: download the full document or a snapshot
 *   PUT                    admin: save {en?, zh?, syncZh?}; honours If-Match
 *   POST {action}          admin: snapshot / restore / import
 *
 * PUT and import validate the document against the section registry
 * (lib/cvValidate.ts) first: 422 {code:'INVALID_CV', error, errors} and
 * nothing is written.
 *
 * The save and the restore live in lib/contentOps/cv, which an approved AI
 * proposal uses too; this route adds the session, the rate limit and the
 * page regeneration.
 */

/**
 * The ISR pages that render CV data, regenerated after a save, restore or
 * import (lib/contentOps/refresh refreshCv, which also follows the
 * /publications nav link and re-renders the PDFs).
 */
export { CV_STATIC_PATHS }

function sendInvalid(res: NextApiResponse, errors: CvValidationError[]) {
  return res.status(422).json({ code: 'INVALID_CV', error: invalidCvMessage(errors), errors })
}

function sendConflict(res: NextApiResponse, version: number) {
  const etag = kvEtag(version)
  return sendVersionedJson(res, 409, {
    error: 'conflict',
    message: 'The CV was changed elsewhere since you loaded it. Reload to get the latest version, then re-apply your edits.',
    etag,
  }, etag)
}

export default withApi('cvdata', async (req: NextApiRequest, res: NextApiResponse, ctx) => {
  if (req.method === 'GET') {
    // snapshots list (admin only)
    if (req.query.snapshots === '1') {
      if (!isAuthed(req, res)) return res.status(401).json({ error: 'Unauthorized' })
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json({ files: listSnapshots() })
    }
    // download current or a snapshot (admin only)
    if (req.query.download !== undefined) {
      if (!isAuthed(req, res)) return res.status(401).json({ error: 'Unauthorized' })
      res.setHeader('Cache-Control', 'no-store')
      const fileParam = req.query.file
      if (fileParam !== undefined && fileParam !== '') {
        const file = safeSnapshotName(fileParam)
        if (!file) return res.status(400).json({ error: 'Invalid file name' })
        const raw = readSnapshot(file)
        if (raw === null) return res.status(404).json({ error: 'Not found' })
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Disposition', attachmentDisposition(file))
        return res.status(200).send(raw)
      }
      const data = readCvData()
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', attachmentDisposition('cvdata.json'))
      return res.status(200).send(JSON.stringify(data, null, 2))
    }
    // Public view for everyone — hidden sections, entries, fields and bullets
    // never leave the server. Admin editors use GET /api/admin/cvdata.
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-CV-View', 'public')
    const { en, zh } = readPublicCvData('any')
    return res.status(200).json({ en, zh })
  }

  if (req.method === 'PUT') {
    if (!isAuthed(req, res)) return res.status(401).json({ error: 'Unauthorized' })
    res.setHeader('Cache-Control', 'no-store')
    const rl = rateLimit(req, 30, 10 * 60 * 1000)
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
    if (!rl.allowed) return res.status(429).json({ error: 'Too many updates, try later' })
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const actor = readAdminClaims(req, res)?.email || 'admin'
    const out = await saveCvDoc({ en: body.en, zh: body.zh, syncZh: body.syncZh }, { ifMatch: req.headers['if-match'] }, { log: ctx.log, notify: ownerMail(ctx.log), actor })
    if (!out.ok) {
      if (out.code === 'CONFLICT') return sendConflict(res, out.version)
      if (out.code === 'INVALID_CV') return sendInvalid(res, out.errors)
      return res.status(out.status).json({ error: out.error })
    }
    // Nothing changed: no snapshot, no write, version (ETag) unchanged.
    if (out.unchanged) return sendVersionedJson(res, 200, { ok: true, unchanged: true, etag: out.etag }, out.etag)
    const revalidation = await refreshCv(res, out.nav)
    return sendVersionedJson(res, 200, {
      ok: true,
      etag: out.etag,
      ...(out.r2Warning ? { r2Warning: out.r2Warning } : {}),
      ...revalidation,
    }, out.etag)
  }

  // manual snapshot/import/restore ops
  if (req.method === 'POST') {
    if (!isAuthed(req, res)) return res.status(401).json({ error: 'Unauthorized' })
    res.setHeader('Cache-Control', 'no-store')
    const { action, filename, data } = req.body || {}
    if (action === 'snapshot') {
      const file = saveSnapshot()
      return res.status(200).json({ ok: true, file })
    }
    if (action === 'restore') {
      const result = await restoreCvDoc(filename, {}, { log: ctx.log })
      if (!result.ok) return res.status(result.status).json({ error: result.error })
      const revalidation = await refreshCv(res, result.nav)
      return sendVersionedJson(res, 200, {
        ok: true,
        etag: result.etag,
        ...(result.r2Warning ? { r2Warning: result.r2Warning } : {}),
        ...revalidation,
      }, result.etag)
    }
    if (action === 'import') {
      // overwrite with provided JSON structure
      const payload = parseLoose(data) ?? data
      if (!payload) return res.status(400).json({ error: 'Missing data' })
      // Accept either { en, zh } or a single array meaning EN only
      let enIn: any[] | undefined
      let zhIn: any[] | undefined
      if (Array.isArray(payload)) {
        enIn = payload
        zhIn = []
      } else if (typeof payload === 'object') {
        enIn = Array.isArray((payload as any).en) ? (payload as any).en : undefined
        zhIn = Array.isArray((payload as any).zh) ? (payload as any).zh : undefined
      }
      if (!enIn && !zhIn) return res.status(400).json({ error: 'Invalid structure' })
      if ((enIn && !isSectionArray(enIn)) || (zhIn && !isSectionArray(zhIn))) {
        return res.status(400).json({ error: 'Each language must be an array of sections with a string "sessionName"' })
      }
      enIn = withBareOrcid(enIn)
      zhIn = withBareOrcid(zhIn)
      const current = readCvData()
      // Entries without a uid are filled against the other language as it will be, with the
      // twin rule (lib/cvEntryUid): a variant never ends up selecting the wrong entry.
      if (enIn) enIn = withSectionUidsBeside(enIn, 'en', zhIn ?? current.zh)
      if (zhIn) zhIn = withSectionUidsBeside(zhIn, 'zh', enIn ?? current.en)
      const checkedImport = validateCvDoc({ en: enIn, zh: zhIn })
      if (!checkedImport.ok) return sendInvalid(res, checkedImport.errors)
      const newEn = enIn ?? current.en
      const newZh = zhIn ? syncLanguage(newEn, zhIn) : current.zh
      snapshotCvQuietly(ctx.log, 'import')
      const nav = trackPublicationsNav()
      const importResult = await writeCvData(withEntryUids(reconcileOrcidAuth({ en: newEn, zh: newZh }, current)))
      if (!importResult.ok) return res.status(500).json({ error: importResult.error })
      const etag = kvEtag(importResult.updatedAt)
      const revalidation = await refreshCv(res, nav)
      return sendVersionedJson(res, 200, {
        ok: true,
        etag,
        ...(importResult.r2Warning ? { r2Warning: importResult.r2Warning } : {}),
        ...revalidation,
      }, etag)
    }
    return res.status(400).json({ error: 'Unknown action' })
  }

  res.setHeader('Allow', 'GET,PUT,POST')
  return res.status(405).json({ error: 'Method not allowed' })
})

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '2mb',
    },
  },
}
