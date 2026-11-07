import { kvEtag, restoreErrorStatus, safeSnapshotName, type StoreError } from '../contentStore'
import { readCvDataWithVersion, restoreSnapshot, saveSnapshot } from '../cvdata'
import { refreshGithubData } from '../githubData'
import { readHomeWithVersion, restoreHomeSnapshot, saveHomeSnapshot } from '../home'
import { log as baseLog, type Logger } from '../log'
import { PAGE_NAMES, isPageName, isSafeSlug, itemEtag, parseSnapshotName, readOne, readPage, restoreItemSnapshot, restorePageSnapshot, versionEtag, type PageName } from '../mdx-admin'
import { getPendingRevision } from '../pendingRevisions'
import { trackPublicationsNav } from '../publicationsNav'
import { exactItemVersion } from './items'
import { exactDocVersion } from './home'
import { exactPageVersion } from './pages'

/**
 * Restoring a version from the history — of a post, a case study, a single
 * page, the home page or the CV — shared by the version-history route
 * (pages/api/versions) and by an approved AI proposal (lib/ai/apply).
 * SERVER-ONLY.
 *
 * The state a restore replaces is kept in the history first (writeOne and
 * writePage snapshot the item, an item's unpublished changes are kept too,
 * and the home and CV documents are snapshotted), so a restore can itself
 * be undone. The schedule of an item is never taken from a version.
 *
 * Returns a discriminated union and never touches an HTTP response: a
 * stored restore says what to regenerate (`refresh`), for the caller that
 * holds the response (lib/contentOps/refresh).
 */

export type VersionKind = 'blog' | 'work' | 'page' | 'home' | 'cv'

export type RestoreRefresh =
  | { kind: 'item'; collection: 'blog' | 'work'; slug: string }
  | { kind: 'page'; name: PageName }
  | { kind: 'doc'; type: 'home' | 'cv'; nav: ReturnType<typeof trackPublicationsNav> | null }

export type RestoreVersionResult =
  | { ok: true; etag: string; stored: Record<string, unknown>; r2Warning?: string; refresh: RestoreRefresh }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string }

const PAGE_NAME_ERROR = `name must be one of ${PAGE_NAMES.map((n) => `"${n}"`).join(', ')}`

/** The current version of a target, as the editors and the AI tools name it. */
export function currentVersionOf(kind: VersionKind, ref: string): string {
  if (kind === 'home') return kvEtag(readHomeWithVersion().version)
  if (kind === 'cv') return kvEtag(readCvDataWithVersion().version)
  if (kind === 'page') return isPageName(ref) ? versionEtag(readPage(ref).updatedAt) : '"0"'
  const one = isSafeSlug(ref) ? readOne(kind, ref) : null
  return one ? itemEtag(one.updatedAt, getPendingRevision(kind, ref)?.updatedAt) : itemEtag(0)
}

/**
 * Restore `filename` as the current state of the target. `version`, when
 * given, must be the one exact current version (an item that no longer
 * exists is version "0"): what is replaced is exactly what the caller saw.
 */
export async function restoreVersion(
  kind: VersionKind,
  ref: string,
  filename: unknown,
  opts: { version?: string } = {},
  deps: { log?: Logger } = {},
): Promise<RestoreVersionResult> {
  const log = deps.log ?? baseLog
  if (opts.version !== undefined) {
    const exact = kind === 'home' || kind === 'cv' ? exactDocVersion(opts.version) : kind === 'page' ? exactPageVersion(opts.version) : exactItemVersion(opts.version)
    if (!exact) return { ok: false, status: 400, error: 'Name exactly one version of the target, as it was read' }
    if (exact !== currentVersionOf(kind, ref)) return { ok: false, status: 409, error: 'This was changed since this version was chosen' }
  }

  if (kind === 'home' || kind === 'cv') {
    if (!safeSnapshotName(filename)) return { ok: false, status: 400, error: 'Missing or invalid filename' }
    // Snapshot the live state first so a restore can itself be undone.
    try {
      if (kind === 'home') saveHomeSnapshot()
      else saveSnapshot()
    } catch (err) {
      log.warn('versions: snapshot before restore failed', { type: kind, err })
    }
    const nav = kind === 'cv' ? trackPublicationsNav() : null
    const homeBefore = kind === 'home' ? readHomeWithVersion().home : null
    const result = kind === 'home' ? await restoreHomeSnapshot(filename) : await restoreSnapshot(filename)
    if (!result.ok) return { ok: false, status: restoreErrorStatus(result.error), error: result.error }
    // As for a save (lib/contentOps/home saveHomeDoc): a restored home document
    // that links another GitHub profile or other organizations has their lists
    // loaded before its pages regenerate (lib/githubData refreshGithubData).
    if (kind === 'home') await refreshGithubData(homeBefore, readHomeWithVersion().home)
    return {
      ok: true,
      etag: kvEtag(result.updatedAt),
      stored: {},
      ...(result.r2Warning ? { r2Warning: result.r2Warning } : {}),
      refresh: { kind: 'doc', type: kind, nav },
    }
  }

  const info = parseSnapshotName(filename)
  if (!info || info.slug !== ref) return { ok: false, status: 400, error: 'Missing or invalid filename' }
  if (kind === 'page') {
    if (!isPageName(ref)) return { ok: false, status: 400, error: PAGE_NAME_ERROR }
    const result = await restorePageSnapshot(ref, info.filename)
    if (!result.ok) return { ok: false, status: 'notFound' in result ? 404 : 500, error: result.error }
    return { ok: true, etag: versionEtag(readPage(ref).updatedAt), stored: storedOf(result), refresh: { kind: 'page', name: ref } }
  }
  if (!isSafeSlug(ref)) return { ok: false, status: 400, error: 'Missing or invalid slug' }
  const result = await restoreItemSnapshot(kind, ref, info.filename)
  if (!result.ok) return { ok: false, status: 'notFound' in result ? 404 : 500, error: result.error }
  return { ok: true, etag: versionEtag(readOne(kind, ref)?.updatedAt ?? 0), stored: storedOf(result), refresh: { kind: 'item', collection: kind, slug: ref } }
}

/** The store's answer as the route returns it (`ok`, and `r2Warning` when the R2 mirror failed). */
function storedOf(result: Extract<StoreError, { ok: true }>): Record<string, unknown> {
  return { ...result }
}
