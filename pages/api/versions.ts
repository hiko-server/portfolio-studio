/**
 * Unified version history API (admin only)
 *
 * CV and home page (JSON documents):
 * GET  ?type=cv   → list CV file snapshots
 * GET  ?type=home → list Home file snapshots
 * GET  ?type=cv&file=filename&preview=1 → read snapshot JSON (preview)
 * GET  ?type=home&file=filename&preview=1 → read snapshot JSON (preview)
 * POST ?type=cv|home { action:'restore', filename } → restore a file snapshot
 * POST ?type=cv|home { action:'snapshot' } → take a manual snapshot
 *
 * Posts, case studies and pages (MDX, lib/mdx-admin.ts):
 * GET  ?type=blog|work&slug=foo           → list that item's snapshots
 * GET  ?type=page&name=now|uses|about     → list that page's snapshots
 * GET  ?type=…&slug|name=…&file=…&preview=1 → { data: { frontmatter, body } }
 * GET  ?type=blog|work&deleted=1          → { deleted: [{ slug, title, filename, date }] }
 *                                           (snapshots whose item no longer exists)
 * POST ?type=…  { action:'restore', slug|name, filename } → write the snapshot back
 *      (the live state is snapshotted first), regenerate its public pages and
 *      return the new ETag. Works for deleted items too (undo delete).
 *
 * `type`, `slug` and `name` may also be sent in the POST body; the query string wins.
 *
 * Every listed version carries `replacedBy`: { summary, ts, device } of the
 * admin write that took it (from the activity log, lib/audit), or null.
 */
import { listSnapshots as listCvSnapshots, saveSnapshot, readSnapshot } from '../../lib/cvdata'
import { listHomeSnapshots, saveHomeSnapshot, readHomeSnapshot } from '../../lib/home'
import type { NextApiRequest, NextApiResponse } from 'next'
import { safeSnapshotName } from '../../lib/contentStore'
import { isAdminRequest } from '../../lib/auth'
import { sendVersionedJson } from '../../lib/http'
import { refreshCollection, refreshPage, refreshRestoredDoc } from '../../lib/contentOps/refresh'
import { restoreVersion } from '../../lib/contentOps/versions'
import { withApi } from '../../lib/apiHandler'
import { log } from '../../lib/log'
import { versionNotes, type VersionNote } from '../../lib/audit/store'
import type { SnapshotKind as AuditSnapshotKind } from '../../lib/audit/context'
import {
  PAGE_NAMES,
  isPageName,
  isSafeSlug,
  listDeleted,
  listSnapshots,
  parseSnapshotName,
  readSnapshot as readMdxSnapshot,
  type SnapshotKind,
} from '../../lib/mdx-admin'

const isAuthed = isAdminRequest

type JsonDocType = 'cv' | 'home'
type VersionType = JsonDocType | SnapshotKind

const TYPES: readonly VersionType[] = ['cv', 'home', 'blog', 'work', 'page']

const PAGE_NAME_ERROR = `name must be one of ${PAGE_NAMES.map((n) => `"${n}"`).join(', ')}`

function parseType(value: unknown): VersionType | null {
  if (value === undefined || value === '') return null
  return (TYPES as readonly unknown[]).includes(value) ? (value as VersionType) : null
}

function parseFilename(name: string): { date: string; label: string } {
  // cv_2025-09-09_03-17-28-947.json  or  home_2025-09-09_03-17-28-947.json
  const m = name.match(/^(?:cv|home)_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/)
  if (m) {
    // Snapshot stamps are UTC (toISOString) — keep the Z so clients convert
    // to their own timezone instead of misreading it as local time.
    const dateStr = `${m[1]}T${m[2].replace(/-/g, ':')}Z`
    return { date: dateStr, label: new Date(dateStr).toUTCString() }
  }
  return { date: '', label: name }
}

/**
 * For each snapshot, the change that replaced it (the activity log links
 * the write to the version it took first — lib/audit); absent for older
 * snapshots. Never fails the listing.
 */
function notesFor(kind: AuditSnapshotKind, files: string[]): Map<string, VersionNote> {
  try {
    return versionNotes(kind, files)
  } catch (err) {
    log.warn('versions: activity notes unavailable', { kind, err })
    return new Map()
  }
}

function mdxVersions(kind: SnapshotKind, slug: string) {
  const list = listSnapshots(kind, slug)
  const notes = notesFor(kind, list.map((s) => s.filename))
  return list.map((s, idx) => ({
    filename: s.filename,
    date: s.date,
    label: new Date(s.date).toUTCString(),
    index: idx,
    isLatest: idx === 0,
    type: kind,
    replacedBy: notes.get(s.filename) ?? null,
  }))
}

/** Snapshot history of posts, case studies and pages. */
async function handleMdx(req: NextApiRequest, res: NextApiResponse, kind: SnapshotKind) {
  const fromBody = req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : {}
  const rawRef = kind === 'page' ? req.query.name ?? req.query.slug ?? fromBody.name ?? fromBody.slug : req.query.slug ?? fromBody.slug

  if (req.method === 'GET' && kind !== 'page' && req.query.deleted === '1') {
    return res.status(200).json({ ok: true, deleted: listDeleted(kind) })
  }

  const ref = typeof rawRef === 'string' ? rawRef : ''
  if (kind === 'page' ? !isPageName(ref) : !isSafeSlug(ref)) {
    return res.status(400).json({ error: kind === 'page' ? PAGE_NAME_ERROR : 'Missing or invalid slug' })
  }

  if (req.method === 'GET') {
    if (req.query.file !== undefined && req.query.preview === '1') {
      const info = parseSnapshotName(req.query.file)
      if (!info || info.slug !== ref) return res.status(400).json({ error: 'Invalid file name' })
      const doc = readMdxSnapshot(kind, info.filename)
      if (!doc) return res.status(404).json({ error: 'Not found' })
      return res.status(200).json({ ok: true, data: doc })
    }
    return res.status(200).json({ ok: true, versions: mdxVersions(kind, ref) })
  }

  if (req.method === 'POST') {
    const { action, filename } = fromBody as { action?: unknown; filename?: unknown }
    if (action !== 'restore') return res.status(400).json({ error: 'Unknown action' })
    // The restore lives in lib/contentOps/versions (an approved AI proposal restores through it too).
    const result = await restoreVersion(kind, ref, filename)
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    const refreshed =
      result.refresh.kind === 'page' ? await refreshPage(res, result.refresh.name) : result.refresh.kind === 'item' ? await refreshCollection(res, result.refresh.collection, result.refresh.slug) : {}
    return sendVersionedJson(res, 200, { ...result.stored, etag: result.etag, ...refreshed }, result.etag)
  }

  res.setHeader('Allow', 'GET,POST')
  return res.status(405).json({ error: 'Method not allowed' })
}

export default withApi('versions', async (req, res) => {
  if (!isAuthed(req, res)) return res.status(401).json({ error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')

  const rawType = req.query.type ?? (req.method === 'POST' ? req.body?.type : undefined)
  const parsedType = parseType(rawType)
  if (rawType !== undefined && rawType !== '' && !parsedType) {
    return res.status(400).json({ error: 'type must be one of cv, home, blog, work, page' })
  }
  const anyType: VersionType = parsedType ?? 'cv'
  if (anyType === 'blog' || anyType === 'work' || anyType === 'page') return handleMdx(req, res, anyType)
  const type: JsonDocType = anyType

  if (req.method === 'GET') {
    const fileParam = req.query.file
    const preview = req.query.preview === '1'

    // Preview a specific snapshot
    if (fileParam !== undefined && preview) {
      const file = safeSnapshotName(fileParam)
      if (!file) return res.status(400).json({ error: 'Invalid file name' })
      const raw = type === 'home' ? readHomeSnapshot(file) : readSnapshot(file)
      if (raw === null) return res.status(404).json({ error: 'Not found' })
      try {
        return res.status(200).json({ ok: true, data: JSON.parse(raw) })
      } catch {
        return res.status(200).json({ ok: true, data: raw })
      }
    }

    // List all snapshots with metadata
    const files = type === 'home' ? listHomeSnapshots() : listCvSnapshots()
    const notes = notesFor(type, files)
    const versions = files.map((f, idx) => {
      const { date, label } = parseFilename(f)
      return {
        filename: f,
        date,
        label,
        index: idx,
        isLatest: idx === 0,
        type,
        replacedBy: notes.get(f) ?? null,
      }
    })
    return res.status(200).json({ ok: true, versions })
  }

  if (req.method === 'POST') {
    const { action, filename } = req.body || {}

    if (action === 'snapshot') {
      const file = type === 'home' ? saveHomeSnapshot() : saveSnapshot()
      return res.status(200).json({ ok: true, file })
    }

    if (action === 'restore') {
      // Snapshot first, then restore (lib/contentOps/versions).
      const result = await restoreVersion(type, type, filename)
      if (!result.ok) return res.status(result.status).json({ error: result.error })
      const nav = result.refresh.kind === 'doc' ? result.refresh.nav : null
      // The document's ISR pages, and the nav link of the others when /publications appeared or disappeared.
      return sendVersionedJson(res, 200, {
        ok: true,
        etag: result.etag,
        ...(result.r2Warning ? { r2Warning: result.r2Warning } : {}),
        ...(await refreshRestoredDoc(res, type, nav)),
      }, result.etag)
    }

    return res.status(400).json({ error: 'Unknown action' })
  }

  res.setHeader('Allow', 'GET,POST')
  return res.status(405).json({ error: 'Method not allowed' })
})
