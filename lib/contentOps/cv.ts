import { ifMatchAllows, kvEtag, restoreErrorStatus, safeSnapshotName, stableStringify } from '../contentStore'
import { readCvDataWithVersion, restoreSnapshot, saveSnapshot, syncLanguage, writeCvData } from '../cvdata'
import { withEntryUids } from '../cvEntryUid'
import { validateCvDoc, type CvValidationError } from '../cvValidate'
import type { Logger } from '../log'
import { reconcileOrcidAuth } from '../orcid/connection'
import { withBareOrcid } from '../orcid/id'
import { trackPublicationsNav } from '../publicationsNav'
import { exactDocVersion, type RestoreDocResult } from './home'
import type { OwnerNotice } from './notify'

/**
 * The writes of the CV document — the save and the restore of a snapshot —
 * shared by its route (pages/api/cvdata) and by an approved AI proposal
 * (lib/ai/apply), so every path runs the same checks and normalisers in
 * the same order. SERVER-ONLY.
 *
 * Each returns a discriminated union and never touches an HTTP response; a
 * stored change carries `nav` (lib/publicationsNav, taken before the write)
 * for the caller that holds the response to regenerate the CV pages with
 * (lib/contentOps/refresh refreshCv). The owner's mail goes through the
 * injected `notify`.
 */

type PublicationsNav = ReturnType<typeof trackPublicationsNav>

/**
 * Accept real JSON values, or a JSON string (with a BOM / trailing commas
 * tolerated). String *contents* are never rewritten.
 */
export function parseLoose(v: any): any {
  if (typeof v !== 'string') return v
  const src = v.replace(/^﻿/, '')
  try {
    return JSON.parse(src)
  } catch {
    try {
      return JSON.parse(src.replace(/,(\s*[}\]])/g, '$1'))
    } catch {
      return undefined
    }
  }
}

export function isSectionArray(v: unknown): v is any[] {
  return Array.isArray(v) && v.every((s) => s && typeof s === 'object' && typeof (s as any).sessionName === 'string')
}

export type CvProblem =
  | { ok: false; status: 400; code: 'BAD_REQUEST'; error: string }
  | { ok: false; status: 422; code: 'INVALID_CV'; error: string; errors: CvValidationError[] }
  | { ok: false; status: 409; code: 'CONFLICT'; version: number }
  | { ok: false; status: 500; code: 'STORE_ERROR'; error: string }

export type SaveCvResult =
  | { ok: true; unchanged: true; etag: string }
  | { ok: true; unchanged: false; etag: string; r2Warning?: string; nav: PublicationsNav }
  | CvProblem

export type CvDeps = {
  log: Logger
  notify?: (notice: OwnerNotice) => void
  /** Who saved, for the owner's mail ("CV updated by …"). */
  actor?: string
}

/** The 422 answer's sentence for a document that fails the registry check. */
export function invalidCvMessage(errors: readonly CvValidationError[]): string {
  return `The CV has ${errors.length === 1 ? 'an invalid value' : `${errors.length} invalid values`}; nothing was saved.`
}

/** Keep the current state recoverable before a write; a failed snapshot never blocks the write. */
export function snapshotCvQuietly(log: Logger, before: string) {
  try {
    saveSnapshot()
  } catch (err) {
    log.warn('CV snapshot failed', { before, err })
  }
}

/**
 * Save `{ en?, zh?, syncZh? }`: a pasted ORCID link is stored as the bare
 * iD, entry uids are filled before the registry check (only the languages
 * sent are checked: 422 INVALID_CV, nothing written), the ORCID marker is
 * the server's (kept only where the stored one is still sent with the same
 * iD), every top-level entry keeps or gets its uid, and an unchanged
 * document writes nothing. `ifMatch` is the route's If-Match header; any
 * other caller passes `version`, one exact kvEtag, checked again atomically
 * inside the write.
 */
export async function saveCvDoc(
  input: { en?: unknown; zh?: unknown; syncZh?: unknown },
  opts: { ifMatch?: string | string[]; version?: string },
  deps: CvDeps,
): Promise<SaveCvResult> {
  const exact = opts.version === undefined ? null : exactDocVersion(opts.version)
  if (opts.version !== undefined && !exact) return { ok: false, status: 400, code: 'BAD_REQUEST', error: 'Name exactly one version of the CV, as it was read' }
  const allows = (version: number) => (exact !== null ? exact === kvEtag(version) : ifMatchAllows(opts.ifMatch, version))
  const syncZh = !!input.syncZh
  // A pasted ORCID link is stored as the bare iD (lib/orcid/id).
  const en = withBareOrcid(parseLoose(input.en))
  const zh = withBareOrcid(parseLoose(input.zh))
  // Entry uids are filled (and duplicates repaired) before the check (lib/cvEntryUid).
  const filled = withEntryUids({ en: isSectionArray(en) ? en : [], zh: isSectionArray(zh) ? zh : [] })
  if (en === undefined && zh === undefined) return { ok: false, status: 400, code: 'BAD_REQUEST', error: 'Missing payload' }
  if ((en !== undefined && !isSectionArray(en)) || (zh !== undefined && !isSectionArray(zh))) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', error: 'Each language must be an array of sections with a string "sessionName"' }
  }
  // Only the languages that were sent are checked: a legacy value elsewhere
  // in the stored document never blocks an unrelated save.
  const checked = validateCvDoc({ en: en === undefined ? undefined : filled.en, zh: zh === undefined ? undefined : filled.zh })
  if (!checked.ok) return { ok: false, status: 422, code: 'INVALID_CV', error: invalidCvMessage(checked.errors), errors: checked.errors }

  const current = readCvDataWithVersion()
  if (!allows(current.version)) return { ok: false, status: 409, code: 'CONFLICT', version: current.version }

  const newEn = Array.isArray(en) ? filled.en : current.en
  const baseZh = Array.isArray(zh) ? filled.zh : current.zh
  const newZh = syncZh ? syncLanguage(newEn, baseZh) : baseZh
  // The ORCID "authenticated" marker is the server's: kept only where the
  // stored one is still sent with the same iD (lib/orcid/connection).
  // Every top-level entry keeps (or gets) its stable uid — CV variants select by it (lib/cvEntryUid).
  const next = withEntryUids(reconcileOrcidAuth({ en: newEn, zh: newZh }, current))

  // Nothing changed: no snapshot, no write, version (ETag) unchanged.
  if (stableStringify(next) === stableStringify({ en: current.en, zh: current.zh })) return { ok: true, unchanged: true, etag: kvEtag(current.version) }

  const nav = trackPublicationsNav()
  snapshotCvQuietly(deps.log, 'write')
  // The version check is repeated atomically inside the write transaction.
  const writeResult = await writeCvData(next, { precondition: (version) => allows(version) })
  if (!writeResult.ok) {
    if (writeResult.conflict) return { ok: false, status: 409, code: 'CONFLICT', version: writeResult.conflict.updatedAt }
    return { ok: false, status: 500, code: 'STORE_ERROR', error: writeResult.error }
  }
  deps.notify?.({ kind: 'cv', subject: 'CV updated', text: `CV updated by ${deps.actor || 'admin'} at ${new Date().toISOString()}\nSyncZh=${syncZh}` })
  return { ok: true, unchanged: false, etag: kvEtag(writeResult.updatedAt), nav, ...(writeResult.r2Warning ? { r2Warning: writeResult.r2Warning } : {}) }
}

/**
 * Restore a CV snapshot (the current state is snapshotted first: restoring
 * is itself undoable). `version`, when given, must be the one exact current
 * version. A stored restore carries `nav` for the regeneration.
 */
export async function restoreCvDoc(filename: unknown, opts: { version?: string }, deps: CvDeps): Promise<(Extract<RestoreDocResult, { ok: true }> & { nav: PublicationsNav }) | Extract<RestoreDocResult, { ok: false }>> {
  if (!safeSnapshotName(filename)) return { ok: false, status: 400, error: 'Missing or invalid filename' }
  if (opts.version !== undefined) {
    const exact = exactDocVersion(opts.version)
    if (!exact) return { ok: false, status: 400, error: 'Name exactly one version of the CV, as it was read' }
    if (exact !== kvEtag(readCvDataWithVersion().version)) return { ok: false, status: 409, error: 'The CV was changed since this version was chosen' }
  }
  // Keep the current state recoverable: restoring is itself undoable.
  snapshotCvQuietly(deps.log, 'restore')
  const nav = trackPublicationsNav()
  const result = await restoreSnapshot(filename)
  if (!result.ok) return { ok: false, status: restoreErrorStatus(result.error), error: result.error }
  return { ok: true, etag: kvEtag(result.updatedAt), nav, ...(result.r2Warning ? { r2Warning: result.r2Warning } : {}) }
}
