import { PAGE_NAMES, isPageName, type PageName } from './pageNames'
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import type { NextApiRequest, NextApiResponse } from 'next'
import { getDb } from './db'
import { log } from './log'
import { sendVersionedJson } from './http'
import { detectContentLang } from './toc'
import { noteSnapshot } from './audit/context'
import {
  getPage,
  putPage as storePutPage,
  listItems,
  getItem,
  putItem as storePutItem,
  removeItem,
  jsonSafeFrontmatter,
  kvEtag,
  ifMatchAllows,
  type PutItemOptions,
  type StoreError,
} from './contentStore'
import { deletePendingRevision, getPendingRevision } from './pendingRevisions'
import { redirectsTo } from './redirects'
import { revokeLinksAt } from './review/store'
import { carryScheduleOnSave, itemSchedule, withoutSchedule } from './schedule/fields'
import { rearmPublishScheduler } from './schedule/scheduler'

/**
 * Admin-only operations for MDX collections and the single pages (/now,
 * /uses and the /about bio). The collections' admin API is lib/collectionApi;
 * its write sequences (save, publish, delete …) are lib/contentOps/items.
 *
 * Backed by the dual-write content store (SQLite + Cloudflare R2). Legacy
 * filesystem (content/*.mdx) is auto-seeded into the DB on first read and
 * is no longer mutated by admin writes — operators manage the canonical
 * copy through the DB/R2 pair, with the migration scripts as the bridge.
 *
 * Versions: every read carries `updatedAt` (the store row's updated_at in
 * ms, 0 when there is no row), which the admin APIs send as the ETag.
 *
 * Snapshot strategy:
 *   On every write/delete, the current DB record (if any) is serialised to
 *   data/{blog|work|page}_snapshots/{slug}_{UTC stamp}.mdx so the history
 *   drawer can offer diff + restore and deleted items can be brought back.
 *   Only the newest SNAPSHOTS_PER_ITEM files of each slug are kept. Slugs
 *   may contain '_', so filenames are parsed with a right-anchored pattern.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-_]*$/

/** Snapshots kept per item (older ones are pruned after each new snapshot). */
export const SNAPSHOTS_PER_ITEM = 50

/** `<slug>_<YYYY-MM-DD_HH-MM-SS-mmm>.mdx`; the stamp is UTC. */
export const MDX_SNAPSHOT_RE = /^(.+)_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3})\.mdx$/

export type Collection = 'blog' | 'work'
export type SnapshotKind = Collection | 'page'

export type SnapshotInfo = {
  filename: string
  slug: string
  /** ISO timestamp (UTC) the snapshot was taken. */
  date: string
}

export type SnapshotDoc = {
  frontmatter: Record<string, any>
  body: string
}

function dataDir(): string {
  return path.join(process.cwd(), 'data')
}

function snapshotDir(kind: SnapshotKind): string {
  return path.join(dataDir(), `${kind}_snapshots`)
}

export function isSafeSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && slug.length <= 128 && SLUG_RE.test(slug)
}

/** Parse a snapshot filename; null for anything that is not one of ours. */
export function parseSnapshotName(filename: unknown): SnapshotInfo | null {
  if (typeof filename !== 'string' || filename.includes('/') || filename.includes('\\')) return null
  const m = MDX_SNAPSHOT_RE.exec(filename)
  if (!m || !SLUG_RE.test(m[1])) return null
  const [day, time] = m[2].split('_')
  const [hh, mm, ss, ms] = time.split('-')
  const date = `${day}T${hh}:${mm}:${ss}.${ms}Z`
  if (Number.isNaN(Date.parse(date))) return null
  return { filename, slug: m[1], date }
}

function stampOf(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

/** Every snapshot in a kind's directory, newest first. */
function allSnapshots(kind: SnapshotKind): SnapshotInfo[] {
  let files: string[]
  try {
    files = fs.readdirSync(snapshotDir(kind))
  } catch {
    return []
  }
  const out: SnapshotInfo[] = []
  for (const f of files) {
    const info = parseSnapshotName(f)
    if (info) out.push(info)
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** Snapshots of one slug / page name, newest first. */
export function listSnapshots(kind: SnapshotKind, slug: string): SnapshotInfo[] {
  if (!isSafeSlug(slug)) return []
  return allSnapshots(kind).filter((s) => s.slug === slug)
}

/** Keep only the newest `keep` snapshots of `slug`; returns the removed names. */
export function pruneItemSnapshots(kind: SnapshotKind, slug: string, keep = SNAPSHOTS_PER_ITEM): string[] {
  const removed: string[] = []
  for (const s of listSnapshots(kind, slug).slice(Math.max(0, keep))) {
    try {
      fs.unlinkSync(path.join(snapshotDir(kind), s.filename))
      removed.push(s.filename)
    } catch (err) {
      log.warn('could not prune snapshot', { file: s.filename, err })
    }
  }
  return removed
}

/** True when `slug` has snapshots (e.g. a deleted item's history). */
export function hasItemSnapshots(kind: SnapshotKind, slug: string): boolean {
  return listSnapshots(kind, slug).length > 0
}

/**
 * Move an item's history to its new slug after a rename (H6): every
 * `<from>_<stamp>.mdx` becomes `<to>_<stamp>.mdx`, so the history drawer
 * keeps showing it and the old slug never shows up under "Recently
 * deleted". Returns how many files moved.
 */
export function moveItemSnapshots(kind: SnapshotKind, from: string, to: string): number {
  if (!isSafeSlug(from) || !isSafeSlug(to)) return 0
  let moved = 0
  for (const s of listSnapshots(kind, from)) {
    const stamp = MDX_SNAPSHOT_RE.exec(s.filename)?.[2]
    if (!stamp) continue
    const target = path.join(snapshotDir(kind), `${to}_${stamp}.mdx`)
    if (fs.existsSync(target)) continue
    try {
      fs.renameSync(path.join(snapshotDir(kind), s.filename), target)
      moved++
    } catch (err) {
      log.warn('could not move snapshot after a rename', { file: s.filename, err })
    }
  }
  return moved
}

/** Read and parse one snapshot (frontmatter + body); null when missing or unsafe. */
export function readSnapshot(kind: SnapshotKind, filename: unknown): SnapshotDoc | null {
  const info = parseSnapshotName(filename)
  if (!info) return null
  const fp = path.join(snapshotDir(kind), info.filename)
  let raw: string
  try {
    raw = fs.readFileSync(fp, 'utf-8')
  } catch {
    return null
  }
  const parsed = matter(raw)
  // gray-matter caches by input string and hands back the same object.
  return { frontmatter: jsonSafeFrontmatter({ ...parsed.data }), body: parsed.content }
}

function writeSnapshot(kind: SnapshotKind, slug: string, frontmatter: Record<string, any>, body: string): string {
  const dir = snapshotDir(kind)
  fs.mkdirSync(dir, { recursive: true })
  let now = new Date()
  let filename = `${slug}_${stampOf(now)}.mdx`
  // Two snapshots in the same millisecond must not overwrite each other.
  while (fs.existsSync(path.join(dir, filename))) {
    now = new Date(now.getTime() + 1)
    filename = `${slug}_${stampOf(now)}.mdx`
  }
  const yaml = matter.stringify(body || '\n', frontmatter)
  fs.writeFileSync(path.join(dir, filename), yaml, 'utf-8')
  pruneItemSnapshots(kind, slug)
  // The activity log links this version to the write that replaces it (lib/audit).
  noteSnapshot(kind, filename)
  return filename
}

// ── Collections (blog, work) ──────────────────────────────────────────────

export function listAll(c: Collection): Array<{
  slug: string
  frontmatter: Record<string, any>
  size: number
  mtime: number
  /** The item's language as the site uses it: frontmatter `lang`, else detected (lib/toc) — the editors' translation block. */
  lang: string
}> {
  return listItems(c).map((item) => {
    const yaml = matter.stringify(item.body || '\n', item.frontmatter)
    return {
      slug: item.slug,
      frontmatter: item.frontmatter,
      size: Buffer.byteLength(yaml, 'utf-8'),
      mtime: item.updated_at,
      lang: detectContentLang({ lang: item.frontmatter?.lang, title: item.frontmatter?.title, body: item.body }),
    }
  })
}

/**
 * The other language versions of a piece (translationPartners) and the
 * regeneration after a post / case-study write (refreshCollection) live in
 * lib/contentOps/refresh; re-exported here for existing importers.
 */
export { refreshCollection, translationPartners } from './contentOps/refresh'

export type AdminItem = {
  slug: string
  frontmatter: Record<string, any>
  body: string
  /** Store row updated_at (ms), the item's version. */
  updatedAt: number
}

export function readOne(c: Collection, slug: string): AdminItem | null {
  if (!isSafeSlug(slug)) return null
  const item = getItem(c, slug)
  if (!item) return null
  return { slug: item.slug, frontmatter: item.frontmatter, body: item.body, updatedAt: Math.trunc(item.updated_at) }
}

/** Snapshot the live item (if any); returns the snapshot filename. */
function snapshot(c: Collection, slug: string): string | null {
  const existing = getItem(c, slug)
  if (!existing) return null
  return writeSnapshot(c, slug, existing.frontmatter, existing.body)
}

export async function writeOne(
  c: Collection,
  slug: string,
  frontmatter: Record<string, any>,
  body: string,
  opts: PutItemOptions = {},
): Promise<StoreError> {
  if (!isSafeSlug(slug)) return { ok: false, error: 'Invalid slug (use a-z, 0-9, -, _)' }
  snapshot(c, slug)
  return await storePutItem(c, slug, frontmatter, body, opts)
}

export async function deleteOne(
  c: Collection,
  slug: string,
): Promise<(StoreError & { snapshot?: string }) | { ok: false; error: string }> {
  if (!isSafeSlug(slug)) return { ok: false, error: 'Invalid slug' }
  const existing = getItem(c, slug)
  if (!existing) return { ok: false, error: 'Not found' }
  const snap = snapshot(c, slug)
  const result = await removeItem(c, slug)
  return result.ok && snap ? { ...result, snapshot: snap } : result
}

export type DeletedItem = {
  slug: string
  title: string
  /** Newest snapshot (the state right before the delete). */
  filename: string
  date: string
}

/** Slugs that have snapshots but no live item, newest deletion first. */
export function listDeleted(c: Collection, limit = 100): DeletedItem[] {
  const live = new Set(listItems(c).map((i) => i.slug))
  const seen = new Set<string>()
  const out: DeletedItem[] = []
  for (const s of allSnapshots(c)) {
    if (live.has(s.slug) || seen.has(s.slug)) continue
    seen.add(s.slug)
    const doc = readSnapshot(c, s.filename)
    const title = doc && typeof doc.frontmatter.title === 'string' ? doc.frontmatter.title : ''
    out.push({ slug: s.slug, title, filename: s.filename, date: s.date })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Write a snapshot back as the live item (the current state, if any, is
 * snapshotted first by writeOne, so a restore can itself be undone).
 * Unpublished changes (H4) are what the editor shows, and the restore
 * replaces them too — so they are kept in the history first, never lost.
 */
export async function restoreItemSnapshot(
  c: Collection,
  slug: string,
  filename: string,
): Promise<StoreError | { ok: false; error: string; notFound: true }> {
  const info = parseSnapshotName(filename)
  if (!info || info.slug !== slug) return { ok: false, error: 'Snapshot not found', notFound: true }
  const doc = readSnapshot(c, filename)
  if (!doc) return { ok: false, error: 'Snapshot not found', notFound: true }
  const pending = getPendingRevision(c, slug)
  if (pending) writeSnapshot(c, slug, pending.frontmatter, pending.body)
  // The schedule (H5) is not part of a version: the restored item keeps the current one, never the snapshot's.
  const current = getItem(c, slug)
  const frontmatter = carryScheduleOnSave({ target: 'live', live: current?.frontmatter ?? null, pending: null, incoming: doc.frontmatter, now: Date.now() })
  // Restoring a deleted item puts an item at an address again: no review link left there may show it (SECU-1).
  const out = await writeOne(c, slug, frontmatter, doc.body, current ? {} : { inTransaction: () => void revokeLinksAt(c, slug) })
  if (out.ok && pending) deletePendingRevision(c, slug)
  if (out.ok) rearmPublishScheduler()
  return out
}

// ── Single-file pages (now, uses, about) ──────────────────────────────────

/**
 * The owner-written single pages: /now and /uses (an automatic version shows
 * while the body is empty), the bio on /about (no bio section while it is
 * empty) and the Chinese bio, which publishes /zh/about (lib/pageNames).
 */
export { PAGE_NAMES, isPageName, type PageName }

function pageUpdatedAt(name: PageName): number {
  const row = getDb().prepare('SELECT updated_at FROM pages WHERE name = ?').get(name) as
    | { updated_at: number }
    | undefined
  return row ? Math.trunc(row.updated_at) : 0
}

export function readPage(name: PageName): {
  name: PageName
  frontmatter: Record<string, any>
  body: string
  /** Store row updated_at (ms), 0 when the page has never been stored. */
  updatedAt: number
} {
  const page = getPage(name)
  if (!page) return { name, frontmatter: {}, body: '', updatedAt: 0 }
  return { name, frontmatter: page.frontmatter, body: page.body, updatedAt: pageUpdatedAt(name) }
}

function snapshotPage(name: PageName): string | null {
  const existing = getPage(name)
  if (!existing) return null
  return writeSnapshot('page', name, existing.frontmatter, existing.body)
}

export async function writePage(
  name: PageName,
  frontmatter: Record<string, any>,
  body: string,
): Promise<StoreError> {
  if (!isPageName(name)) return { ok: false, error: 'Invalid page name' }
  snapshotPage(name)
  return await storePutPage(name, frontmatter, body)
}

export async function restorePageSnapshot(
  name: PageName,
  filename: string,
): Promise<StoreError | { ok: false; error: string; notFound: true }> {
  const info = parseSnapshotName(filename)
  if (!info || info.slug !== name) return { ok: false, error: 'Snapshot not found', notFound: true }
  const doc = readSnapshot('page', filename)
  if (!doc) return { ok: false, error: 'Snapshot not found', notFound: true }
  return await writePage(name, doc.frontmatter, doc.body)
}

// ── HTTP helpers shared by /api/admin/posts, /work and /page ──────────────

/** Strong ETag of an item / page version (`"<updated_at ms>"`, `"0"` when absent). */
export function versionEtag(updatedAt: number): string {
  return kvEtag(updatedAt)
}

/**
 * Optimistic-concurrency check for an admin PUT. No If-Match header keeps the
 * legacy "last write wins" behaviour; otherwise the header must name the
 * current version. On a mismatch this answers 409 VERSION_CONFLICT (with the
 * current ETag, so the editor can offer "Reload latest") and returns false.
 */
export function checkIfMatch(req: NextApiRequest, res: NextApiResponse, currentUpdatedAt: number): boolean {
  if (ifMatchAllows(req.headers['if-match'], currentUpdatedAt)) return true
  const etag = versionEtag(currentUpdatedAt)
  sendVersionedJson(
    res,
    409,
    { code: 'VERSION_CONFLICT', error: 'This was changed elsewhere since you loaded it', etag },
    etag,
  )
  return false
}

export type MdxProblem = { code: 'MDX_INVALID'; line: number | null; column: number | null; reason: string; error: string }

type Compiled = Awaited<ReturnType<typeof import('./mdx').compileMdx>>

/**
 * Compile a body with the public renderer (lib/mdx compileMdx) without
 * storing anything: the rendered tree, or the 422 payload with the position
 * of the first error. Anything the renderer throws counts — a body it cannot
 * compile would break the public page.
 */
export async function compileForAdmin(body: string): Promise<({ ok: true } & Compiled) | { ok: false; problem: MdxProblem }> {
  const { compileMdx, MdxCompileError } = await import('./mdx')
  try {
    return { ok: true, ...(await compileMdx(body)) }
  } catch (err) {
    const known = err instanceof MdxCompileError
    const reason = known ? err.reason : err instanceof Error ? err.message : String(err)
    // Some parser messages carry their position only in the text: "… (3:1-3:10)".
    const inText = /\((\d+):(\d+)(?:-\d+:\d+)?\)/.exec(reason)
    const line = known && typeof err.line === 'number' ? err.line : inText ? Number(inText[1]) : null
    const column = known && typeof err.column === 'number' ? err.column : inText ? Number(inText[2]) : null
    if (!known) log.error('MDX renderer failed on an admin body', { err })
    const where = line !== null ? `Line ${line}${column !== null ? `:${column}` : ''}: ` : ''
    return { ok: false, problem: { code: 'MDX_INVALID', line, column, reason, error: `${where}${reason}` } }
  }
}

/** Null when the body renders, else the 422 MDX_INVALID payload. */
export async function mdxProblem(body: string): Promise<MdxProblem | null> {
  const out = await compileForAdmin(body)
  return out.ok ? null : out.problem
}

/**
 * Version of an item as the editor sees it (H4): the live row's updated_at,
 * plus the pending revision's when there is one — `"<live>"` or
 * `"<live>.<pending>"`. Any change to either (a save in another tab, a
 * publish, a discard, a restore) changes it, so If-Match catches them all.
 */
export function itemEtag(liveUpdatedAt: number, pendingUpdatedAt?: number | null): string {
  const live = Number.isFinite(liveUpdatedAt) && liveUpdatedAt > 0 ? Math.trunc(liveUpdatedAt) : 0
  const pending = typeof pendingUpdatedAt === 'number' && pendingUpdatedAt > 0 ? Math.trunc(pendingUpdatedAt) : 0
  return pending ? `"${live}.${pending}"` : `"${live}"`
}

/** If-Match against an item version (itemEtag); no header keeps "last write wins". */
export function itemIfMatchAllows(header: string | string[] | undefined, liveUpdatedAt: number, pendingUpdatedAt?: number | null): boolean {
  const raw = Array.isArray(header) ? header.join(',') : header
  if (typeof raw !== 'string' || raw.trim() === '') return true
  const current = itemEtag(liveUpdatedAt, pendingUpdatedAt)
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .some((t) => (t === '*' ? liveUpdatedAt > 0 : t === current))
}

/**
 * The editor's view of one item (GET ?slug, and the answer of a schedule
 * change): the live version, its pending revision, the old slugs that
 * redirect to it and its schedule (H5) — the frontmatter without the
 * schedule keys, which only the schedule action sets — with its ETag.
 */
export function itemPayload(c: Collection, slug: string): { body: Record<string, unknown>; etag: string } | null {
  const one = readOne(c, slug)
  if (!one) return null
  const pending = getPendingRevision(c, slug)
  return {
    body: {
      ...one,
      frontmatter: withoutSchedule(one.frontmatter),
      pending: pending
        ? { frontmatter: withoutSchedule(pending.frontmatter), body: pending.body, updatedAt: pending.updatedAt, baseUpdatedAt: pending.baseUpdatedAt }
        : null,
      redirectsFrom: redirectsTo(c, slug),
      schedule: itemSchedule(one.frontmatter, pending?.frontmatter),
    },
    etag: itemEtag(one.updatedAt, pending?.updatedAt),
  }
}

/** A stored item counts as a draft when its `draft` flag is truthy (lib/mdx's rule). */
export const isDraftFrontmatter = (fm: Record<string, any> | null | undefined) => Boolean(fm?.draft)
