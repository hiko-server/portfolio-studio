import path from 'path'
import {
  getKvWithMeta,
  listSnapshotFiles,
  publishedItemSlugs,
  putKv,
  readSnapshotFile,
  safeSnapshotName,
  SNAPSHOT_NOT_FOUND,
  writeSnapshotFile,
  type KvPutOptions,
  type KvPutResult,
} from './contentStore'
import { publicCvDoc, withPublishedCaseStudies, type CvAudience, type CvDoc, type CvLang, type CvSurface, type PublicCvOptions } from './cvVisibility'
import { pdfPhoto } from './cvLocale'
import { withEntryUids } from './cvEntryUid'

const snapshotDir = path.join(process.cwd(), 'data', 'cv_snapshots')

export type FullCvDoc = { en: any[]; zh: any[] }

/**
 * Accept the stored `{ en, zh }` shape and the legacy bare EN array. Every
 * top-level entry has its stable uid (lib/cvEntryUid): an entry stored
 * without one gets the same deterministic uid on every read until a save
 * stores it, so CV variants can point at it from the start.
 */
function normalizeCv(json: any): FullCvDoc {
  if (!json) return { en: [], zh: [] }
  const en = Array.isArray(json.en) ? json.en : Array.isArray(json) ? json : []
  const zh = Array.isArray(json.zh) ? json.zh : []
  return withEntryUids({ en, zh })
}

/** FULL document with visibility metadata — admin editors only, never public output. */
export function readCvData(): FullCvDoc {
  return normalizeCv(getKvWithMeta<any>('cvdata').value)
}

/**
 * FULL document plus its version (kv `updated_at`, 0 when no row) for
 * ETag / If-Match handling in the admin API.
 */
export function readCvDataWithVersion(): FullCvDoc & { version: number } {
  const row = getKvWithMeta<any>('cvdata')
  return { ...normalizeCv(row.value), version: row.updatedAt }
}

/**
 * A selection over the FULL document applied before pruning — a CV variant
 * (lib/cvVariants applyVariantDoc) picks and orders sections and entries by
 * uid, which the public views no longer carry.
 */
export type CvSelect = (full: FullCvDoc) => FullCvDoc

/**
 * The CV as visitors may see it: hidden sections / entries / fields / bullets
 * removed (see lib/cvVisibility.ts), and whatever the surface's audience
 * leaves out — 'web' (default: pages, /api/cvdata, search, JSON-LD),
 * 'download' (the files and the vCard) or 'private' (share links). Use this
 * for every public page and the unauthenticated API — never ship
 * readCvData() output to the browser. `opts` as lib/cvVisibility
 * publicCvDoc (entry uids only for the AI tools' view).
 */
export function readPublicCvData(audience: CvAudience = 'any', surface: CvSurface = 'web', select?: CvSelect, opts: PublicCvOptions = {}): CvDoc {
  const full = readCvData()
  return publicCvDataOf(select ? select(full) : full, audience, surface, opts)
}

/**
 * The case studies a public CV may link to: the published ones. A store
 * that cannot list them yields none, so no public payload links any.
 */
export function publishedCaseStudySlugs(): Set<string> {
  try {
    return publishedItemSlugs('work')
  } catch {
    return new Set()
  }
}

/**
 * readPublicCvData's view of a document held in memory (the same rules:
 * lib/cvVisibility publicCvDoc, then a project's case study only when it is
 * published — no draft's or deleted case study's slug in any public
 * payload). `published` defaults to publishedCaseStudySlugs(); a caller
 * computing many views of one store passes it once.
 */
export function publicCvDataOf(
  full: { en?: unknown; zh?: unknown },
  audience: CvAudience = 'any',
  surface: CvSurface = 'web',
  opts: PublicCvOptions = {},
  published: ReadonlySet<string> = publishedCaseStudySlugs(),
): CvDoc {
  const doc = publicCvDoc(full, audience, surface, opts)
  return { en: withPublishedCaseStudies(doc.en, published), zh: withPublishedCaseStudies(doc.zh, published) }
}

/**
 * Public view restricted to the sections a page actually renders (by
 * `sessionName`) and the languages it needs. Pages must use this instead of
 * shipping the whole public CV, so e.g. contact details never end up in the
 * __NEXT_DATA__ of a page that does not display them.
 */
export function readPublicCvSections(
  audience: CvAudience,
  sessionNames: readonly string[],
  langs: readonly CvLang[] = ['en', 'zh'],
  surface: CvSurface = 'web',
  select?: CvSelect,
): CvDoc {
  const wanted = new Set(sessionNames)
  const doc = readPublicCvData(audience, surface, select)
  const pick = (lang: CvLang) =>
    langs.includes(lang) ? doc[lang].filter((s) => wanted.has(String(s.sessionName))) : []
  return { en: pick('en'), zh: pick('zh') }
}

/**
 * PDF hook (E10): the photo the given language's PDF may print, or null.
 * Reads the FULL document — public views never carry the photo — and
 * applies lib/cvLocale pdfPhoto (switch on, section on the CV). For the
 * server-side PDF generator only; never send the result to a web page.
 */
export function readCvPdfPhoto(lang: CvLang): string | null {
  return pdfPhoto(readCvData()[lang])
}

/** Write the full document (every top-level entry with its uid). Pass `precondition` for an atomic If-Match check. */
export async function writeCvData(data: FullCvDoc, opts: KvPutOptions = {}): Promise<KvPutResult> {
  return await putKv('cvdata', withEntryUids(data), opts)
}

// Re-exported for existing importers; implementation is pure (lib/cvSync.ts).
export { syncStructure, syncLanguage } from './cvSync'

/**
 * Snapshot the stored CV into data/cv_snapshots (newest 100 kept). Skips the
 * write when the newest snapshot is identical. A row that is not valid JSON
 * is snapshotted verbatim so its bytes survive the next save.
 */
export function saveSnapshot(): string {
  const row = getKvWithMeta<any>('cvdata')
  const content = row.corrupt && row.raw !== null ? row.raw : JSON.stringify(normalizeCv(row.value), null, 2)
  return writeSnapshotFile(snapshotDir, 'cv', content)
}

export function listSnapshots(): string[] {
  return listSnapshotFiles(snapshotDir)
}

export async function restoreSnapshot(filename: unknown): Promise<KvPutResult> {
  // Never let a caller-supplied name escape the snapshot dir.
  if (!safeSnapshotName(filename)) return { ok: false, error: 'Invalid snapshot name' }
  const raw = readSnapshotFile(snapshotDir, filename)
  if (raw === null) return { ok: false, error: SNAPSHOT_NOT_FOUND }
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'Snapshot is not valid JSON' }
  }
  return await putKv('cvdata', normalizeCv(data))
}

export function readSnapshot(filename: unknown): string | null {
  return readSnapshotFile(snapshotDir, filename)
}
