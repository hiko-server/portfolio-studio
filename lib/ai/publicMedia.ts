import { getPage, listItems } from '../contentStore'
import { readCvData } from '../cvdata'
import { getDb } from '../db'
import { readHome } from '../home'
import { PAGE_NAMES } from '../mdx-admin'
import { MEDIA_META_KEY } from '../media/meta'
import { uploadRefsIn } from '../media/usage'
import { pagePublicPath } from '../pageNames'
import { listPendingRevisions } from '../pendingRevisions'
import { aiCvView, aiHomeView, isDraftRow } from './views'

/**
 * Which uploads an AI view refers to (SERVER-ONLY, design §4.2 list_media).
 *
 * `/uploads/<name>` has no access control beyond knowing the name, so a
 * name is itself private until a public page shows it. The set is computed
 * from the views the tools read (lib/ai/views: the public home, the public
 * CV, the published posts, case studies and pages; drafts and unpublished
 * changes only for draft access), never from the media library's usage
 * index, whose rows also cover hidden photos, the CV's PDF-only photo and
 * other stored documents. So an upload referred to only by something hidden
 * or private is absent at every access level.
 *
 * "Unused" is the one question that needs the stored documents: an upload
 * is unused when nothing stored refers to it at all — hidden and private
 * places included, so a hidden photo or the PDF photo is never offered as
 * unused. Nothing here scans the disk or writes to the database: the file
 * facts come from the library's index as the admin last refreshed it.
 */

export type MediaPlace = {
  /** "home", "cv", "blog/<slug>", "work/<slug>", "page/<name>"; "<collection>/<slug>#pending" for unpublished changes. */
  doc: string
  title: string
  /** live (public), draft, pending (a live item's unpublished changes). */
  state: 'live' | 'draft' | 'pending'
  public_url: string | null
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Every string inside `value` (keys excluded), depth first. */
function eachString(value: unknown, visit: (s: string) => void, depth = 0): void {
  if (depth > 32) return
  if (typeof value === 'string') visit(value)
  else if (Array.isArray(value)) for (const v of value) eachString(v, visit, depth + 1)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) eachString(v, visit, depth + 1)
}

function collect(into: Map<string, MediaPlace[]>, place: MediaPlace, ...values: unknown[]) {
  const seen = new Set<string>()
  for (const v of values) {
    eachString(v, (s) => {
      for (const ref of uploadRefsIn(s)) {
        if (seen.has(ref.name)) continue
        seen.add(ref.name)
        const list = into.get(ref.name)
        if (list) list.push(place)
        else into.set(ref.name, [place])
      }
    })
  }
}

/**
 * Uploads the AI views refer to, with where. Public places always; with
 * `drafts`, also drafts and live items' unpublished changes.
 */
export function viewUploads(opts: { drafts: boolean }): Map<string, MediaPlace[]> {
  const out = new Map<string, MediaPlace[]>()
  const { home } = aiHomeView()
  if (home) collect(out, { doc: 'home', title: 'Home page', state: 'live', public_url: '/' }, home)
  const cv = aiCvView()
  collect(out, { doc: 'cv', title: 'CV', state: 'live', public_url: '/cv' }, cv.en, cv.zh)
  for (const c of ['blog', 'work'] as const) {
    for (const item of listItems(c)) {
      const title = str(item.frontmatter?.title) || item.slug
      if (!isDraftRow(item)) collect(out, { doc: `${c}/${item.slug}`, title, state: 'live', public_url: `/${c}/${item.slug}` }, item.frontmatter, item.body)
      else if (opts.drafts) collect(out, { doc: `${c}/${item.slug}`, title, state: 'draft', public_url: null }, item.frontmatter, item.body)
    }
    if (opts.drafts) {
      const live = new Set(listItems(c).filter((i) => !isDraftRow(i)).map((i) => i.slug))
      for (const p of listPendingRevisions(c)) {
        if (!live.has(p.slug)) continue
        collect(out, { doc: `${c}/${p.slug}#pending`, title: str(p.frontmatter?.title) || p.slug, state: 'pending', public_url: null }, p.frontmatter, p.body)
      }
    }
  }
  for (const name of PAGE_NAMES) {
    const page = getPage(name)
    if (page && page.body.trim()) collect(out, { doc: `page/${name}`, title: str(page.frontmatter?.title) || name, state: 'live', public_url: pagePublicPath(name) }, page.frontmatter, page.body)
  }
  return out
}

/**
 * Every upload any stored document refers to, hidden and private places
 * included: posts, case studies and their unpublished changes, pages, the
 * full home and CV, and the other stored documents the media library counts
 * (lib/media/library usageSources: every kv row but the library's own texts
 * and deletion markers).
 */
export function referencedAnywhere(): Set<string> {
  const out = new Set<string>()
  const add = (v: unknown) =>
    eachString(v, (s) => {
      for (const ref of uploadRefsIn(s)) out.add(ref.name)
    })
  for (const c of ['blog', 'work'] as const) {
    for (const item of listItems(c)) add([item.frontmatter, item.body])
    for (const p of listPendingRevisions(c)) add([p.frontmatter, p.body])
  }
  for (const name of PAGE_NAMES) {
    const page = getPage(name)
    if (page) add([page.frontmatter, page.body])
  }
  add(readHome())
  add(readCvData())
  const rows = getDb()
    .prepare(`SELECT key, value FROM kv WHERE key NOT IN ('home', 'cvdata', ?) AND key NOT LIKE 'tombstones:%'`)
    .all(MEDIA_META_KEY) as Array<{ key: string; value: string }>
  for (const r of rows) {
    try {
      add(JSON.parse(r.value))
    } catch {
      // A row that does not parse refers to nothing the site can render.
    }
  }
  return out
}

export type UploadFacts = { name: string; bytes: number | null; width: number | null; height: number | null }

/** The library's file facts (as last indexed), uploads in the trash left out. */
export function uploadFacts(): Map<string, UploadFacts> {
  const rows = getDb()
    .prepare('SELECT a.name AS name, a.bytes AS bytes, a.width AS width, a.height AS height FROM media_assets a WHERE NOT EXISTS (SELECT 1 FROM media_trash t WHERE t.name = a.name)')
    .all() as Array<{ name: string; bytes: number; width: number | null; height: number | null }>
  return new Map(rows.map((r) => [r.name, { name: r.name, bytes: Number.isFinite(r.bytes) ? Number(r.bytes) : null, width: r.width ?? null, height: r.height ?? null }]))
}
