import { ifMatchAllows, kvEtag, restoreErrorStatus, safeSnapshotName, stableStringify } from '../contentStore'
import { normalizeHomeWrite, readHomeWithVersion, restoreHomeSnapshot, saveHomeSnapshot, writeHome, type HomeData, type HomeFieldError } from '../home'
import { isHomePayload } from '../homePayload'
import type { Logger } from '../log'
import { withLogoMetrics } from '../logoMetrics'
import type { OwnerNotice } from './notify'

/**
 * The writes of the home document — the save and the restore of a
 * snapshot — shared by its route (pages/api/home) and by an approved AI
 * proposal (lib/ai/apply), so every path runs the same checks in the same
 * order. SERVER-ONLY.
 *
 * Each returns a discriminated union and never touches an HTTP response.
 * The caller that holds the response regenerates the home pages
 * (lib/contentOps/refresh refreshHome, which also re-renders the PDF CVs).
 * The owner's notification mail goes through the injected `notify`.
 */

export type HomeProblem =
  | { ok: false; status: 400; code: 'BAD_REQUEST'; error: string }
  | { ok: false; status: 422; code: 'INVALID_HOME'; error: string; errors: HomeFieldError[] }
  | { ok: false; status: 409; code: 'CONFLICT'; version: number }
  | { ok: false; status: 500; code: 'STORE_ERROR'; error: string }

export type SaveHomeResult =
  | { ok: true; unchanged: true; etag: string }
  | { ok: true; unchanged: false; etag: string; r2Warning?: string }
  | HomeProblem

export type HomeDeps = {
  log: Logger
  /** Hears a stored change (the owner's mail); never awaited, never fails the write. */
  notify?: (notice: OwnerNotice) => void
}

/** The exact home version a non-route caller names (kvEtag, quotes optional), or null. */
export function exactDocVersion(version: unknown): string | null {
  if (typeof version !== 'string') return null
  const inner = version.trim().replace(/^"(.*)"$/, '$1')
  return /^\d+$/.test(inner) ? `"${inner}"` : null
}

/** Keep the current state recoverable before a write; a failed snapshot never blocks the write. */
function snapshotQuietly(log: Logger, before: string) {
  try {
    saveHomeSnapshot()
  } catch (err) {
    log.warn('home snapshot failed', { before, err })
  }
}

/**
 * Save the whole home document. Availability, open-source picks, the site
 * name and logo scales are validated and normalised (lib/homeShape
 * normalizeHomeWrite: 422 INVALID_HOME); brand logos are measured for
 * optical sizing (new or changed images only). `ifMatch` is the route's
 * If-Match header (absent: last write wins); any other caller passes
 * `version`, one exact kvEtag. An unchanged document writes nothing. The
 * version is checked again atomically inside the write.
 */
export async function saveHomeDoc(raw: unknown, opts: { ifMatch?: string | string[]; version?: string }, deps: HomeDeps): Promise<SaveHomeResult> {
  if (!isHomePayload(raw)) return { ok: false, status: 400, code: 'BAD_REQUEST', error: 'Invalid payload' }
  const exact = opts.version === undefined ? null : exactDocVersion(opts.version)
  if (opts.version !== undefined && !exact) return { ok: false, status: 400, code: 'BAD_REQUEST', error: 'Name exactly one version of the home page, as it was read' }
  const allows = (version: number) => (exact !== null ? exact === kvEtag(version) : ifMatchAllows(opts.ifMatch, version))
  const checked = normalizeHomeWrite(raw)
  if (!checked.ok) {
    return { ok: false, status: 422, code: 'INVALID_HOME', error: checked.errors.map((e) => e.message).join(' '), errors: checked.errors }
  }
  const current = readHomeWithVersion()
  if (!allows(current.version)) return { ok: false, status: 409, code: 'CONFLICT', version: current.version }

  // Optical logo sizing: measure new or changed brand images (metrics of
  // unchanged ones are carried over from the stored document).
  const body: HomeData = {
    ...checked.home,
    brands: await withLogoMetrics(checked.home.brands, current.home?.brands, deps.log),
  }

  // Nothing changed: no snapshot, no write, version (ETag) unchanged.
  if (current.home && stableStringify(body) === stableStringify(current.home)) return { ok: true, unchanged: true, etag: kvEtag(current.version) }

  snapshotQuietly(deps.log, 'write')
  // The version check is repeated atomically inside the write transaction.
  const writeResult = await writeHome(body, { precondition: (version) => allows(version) })
  if (!writeResult.ok) {
    if (writeResult.conflict) return { ok: false, status: 409, code: 'CONFLICT', version: writeResult.conflict.updatedAt }
    return { ok: false, status: 500, code: 'STORE_ERROR', error: writeResult.error }
  }
  deps.notify?.({ kind: 'home', subject: 'Home updated', text: `Home updated at ${new Date().toISOString()}` })
  return { ok: true, unchanged: false, etag: kvEtag(writeResult.updatedAt), ...(writeResult.r2Warning ? { r2Warning: writeResult.r2Warning } : {}) }
}

export type RestoreDocResult = { ok: true; etag: string; r2Warning?: string } | { ok: false; status: 400 | 404 | 409 | 500; error: string }

/**
 * Restore a home snapshot (the current state is snapshotted first, so the
 * restore can itself be undone). `version`, when given, must be the one
 * exact current version.
 */
export async function restoreHomeDoc(filename: unknown, opts: { version?: string }, deps: HomeDeps): Promise<RestoreDocResult> {
  if (!safeSnapshotName(filename)) return { ok: false, status: 400, error: 'Missing or invalid filename' }
  if (opts.version !== undefined) {
    const exact = exactDocVersion(opts.version)
    if (!exact) return { ok: false, status: 400, error: 'Name exactly one version of the home page, as it was read' }
    if (exact !== kvEtag(readHomeWithVersion().version)) return { ok: false, status: 409, error: 'The home page was changed since this version was chosen' }
  }
  snapshotQuietly(deps.log, 'restore')
  const result = await restoreHomeSnapshot(filename)
  if (!result.ok) return { ok: false, status: restoreErrorStatus(result.error), error: result.error }
  return { ok: true, etag: kvEtag(result.updatedAt), ...(result.r2Warning ? { r2Warning: result.r2Warning } : {}) }
}
