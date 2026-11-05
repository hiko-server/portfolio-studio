import { getItem, type StoreError } from '../contentStore'
import type { EditorialEvent } from '../editorialEvents'
import { log } from '../log'
import {
  deleteOne,
  isDraftFrontmatter,
  isSafeSlug,
  itemEtag,
  itemIfMatchAllows,
  mdxProblem,
  readOne,
  writeOne,
  type MdxProblem,
} from '../mdx-admin'
import { deletePendingRevision, getPendingRevision, putPendingRevision } from '../pendingRevisions'
import { forgetRedirectFrom } from '../redirects'
import { linkSlugsOf, revokeItemLinks, revokeLinksAt } from '../review/store'
import { carryScheduleOnSave, itemSchedule, publishDay, withoutSchedule } from '../schedule/fields'
import { rearmPublishScheduler } from '../schedule/scheduler'
import { ensurePosters } from '../videoPoster'
import type { CollectionRefresh } from './refresh'
import { ITEM_RULES, type Collection } from './rules'

/**
 * The write sequences of posts and case studies (content store collections
 * "blog" and "work"), shared by the admin routes (lib/collectionApi) and by
 * any other server code that saves, publishes, unpublishes or deletes an
 * item for the owner — so every path runs the same checks in the same
 * order. SERVER-ONLY.
 *
 * Each function returns a discriminated union and never touches an HTTP
 * response: a failure carries the status and code the admin API answers
 * with, and a success that changed public pages carries `needsRefresh`
 * for the caller that holds the response (lib/contentOps/refresh
 * refreshCollection). Editorial events (lib/editorialEvents) go through the
 * injected `notify`; the routes pass the request with them.
 *
 * What stays with the routes: authorisation, rate limits and the step-up
 * a delete needs (lib/adminAuth/stepUp requireRecentAuth).
 */

export type { Collection }

export type ItemDeps = {
  /** Hears each editorial action once it succeeded (lib/editorialEvents emitEditorialEvent). */
  notify?: (event: EditorialEvent) => void
  /** Clock for the schedule rules (lib/schedule/fields); Date.now by default. */
  now?: () => number
}

export type ItemProblem =
  | { ok: false; status: 400; code: 'BAD_REQUEST'; error: string }
  | { ok: false; status: 400 | 404; code: 'STORE_ERROR'; error: string }
  | { ok: false; status: 404; code: 'NOT_FOUND'; error: string }
  | { ok: false; status: 409; code: 'SLUG_EXISTS' | 'NOT_PUBLISHED' | 'NOTHING_TO_PUBLISH'; error: string }
  | { ok: false; status: 409; code: 'VERSION_CONFLICT'; error: string; etag: string }
  | { ok: false; status: 422; code: 'MDX_INVALID'; error: string; problem: MdxProblem }

type StoreOk = Extract<StoreError, { ok: true }>

export type SaveItemResult =
  | {
      ok: true
      target: 'live'
      /** The store's answer (`r2Warning` when the R2 mirror failed). */
      stored: StoreOk
      etag: string
      needsRefresh: CollectionRefresh
    }
  | { ok: true; target: 'pending'; etag: string; pending: { updatedAt: number; baseUpdatedAt: number } }
  | ItemProblem

export type SaveItemInput = {
  slug: unknown
  frontmatter: unknown
  body: unknown
  /** True for a new item: refused while the slug is taken (SLUG_EXISTS). */
  create?: unknown
  /** 'live' (default) writes the item; 'pending' stores a published item's unpublished changes (H4). */
  target?: unknown
  /** The version the save was made from (lib/mdx-admin itemEtag); absent or empty: last write wins. */
  ifMatch?: string | string[]
}

const badRequest = (error: string): ItemProblem => ({ ok: false, status: 400, code: 'BAD_REQUEST', error })
const notFound = (): ItemProblem => ({ ok: false, status: 404, code: 'NOT_FOUND', error: 'Not found' })

/** 409 VERSION_CONFLICT with the item's current version, so the editor can offer "Reload latest". */
function versionConflict(liveUpdatedAt: number, pendingUpdatedAt?: number | null): ItemProblem {
  return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'This was changed elsewhere since you loaded it', etag: itemEtag(liveUpdatedAt, pendingUpdatedAt) }
}

/**
 * Save an item (the admin PUT): `target` 'live' writes it — a pending
 * revision is superseded and dropped, a new item takes over its address
 * (review links left there are turned off, an old redirect from it is
 * forgotten) — and 'pending' stores the edits of a PUBLISHED item as its
 * pending revision, leaving the public pages as they are.
 *
 * The body must compile with the public renderer (422 MDX_INVALID, nothing
 * written); the posters of its video players are imported first. The
 * schedule (H5) is server-owned: kept from the stored rows, never taken
 * from the input (lib/schedule/fields carryScheduleOnSave).
 */
export async function saveItem(c: Collection, input: SaveItemInput, deps: ItemDeps = {}): Promise<SaveItemResult> {
  const rules = ITEM_RULES[c]
  const { slug, frontmatter, body, create, target } = input
  if (typeof slug !== 'string' || !slug) return badRequest('Missing slug')
  if (!isSafeSlug(slug)) return badRequest('Invalid slug (use a-z, 0-9, -, _)')
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return badRequest('Missing frontmatter')
  if (target !== undefined && target !== 'live' && target !== 'pending') return badRequest('target must be "live" or "pending"')
  const fm = frontmatter as Record<string, any>
  if (!fm.title) return badRequest('frontmatter.title required')
  if (rules.requireDate && !fm.date) return badRequest('frontmatter.date required')
  if (body !== undefined && typeof body !== 'string') return badRequest('body must be a string')
  const text = body || ''

  const problem = await mdxProblem(text)
  if (problem) return { ok: false, status: 422, code: 'MDX_INVALID', error: problem.error, problem }
  // Posters of the body's video players, imported once into /uploads
  // (bounded wait; the page compiles with whatever is stored by then).
  await ensurePosters(text)

  // Checks and write run without an await in between, so no other
  // request can slip in after the version check (single Node process).
  const existing = readOne(c, slug)
  if (create === true && existing) {
    return { ok: false, status: 409, code: 'SLUG_EXISTS', error: `A ${rules.noun} with this slug already exists` }
  }
  const pendingNow = existing ? getPendingRevision(c, slug) : null
  if (!itemIfMatchAllows(input.ifMatch, existing?.updatedAt ?? 0, pendingNow?.updatedAt)) return versionConflict(existing?.updatedAt ?? 0, pendingNow?.updatedAt)

  // The schedule (H5) is server-owned: kept from the stored rows, never taken from the editor (lib/schedule/fields).
  const scheduled = (to: 'live' | 'pending') =>
    carryScheduleOnSave({ target: to, live: existing?.frontmatter ?? null, pending: pendingNow?.frontmatter ?? null, incoming: fm, now: (deps.now ?? Date.now)() })

  if (target === 'pending') {
    if (!existing || isDraftFrontmatter(existing.frontmatter)) {
      return { ok: false, status: 409, code: 'NOT_PUBLISHED', error: `This ${rules.noun} is not published — save it directly` }
    }
    if (isDraftFrontmatter(fm)) return badRequest('Unpublishing is a direct save (target "live")')
    const rev = putPendingRevision(c, slug, scheduled('pending'), text, existing.updatedAt)
    return { ok: true, target: 'pending', etag: itemEtag(existing.updatedAt, rev.updatedAt), pending: { updatedAt: rev.updatedAt, baseUpdatedAt: rev.baseUpdatedAt } }
  }

  const before = itemSchedule(existing?.frontmatter, pendingNow?.frontmatter)
  // A new item takes over an address: review links made there for a deleted item, or for a
  // renamed one whose old address this reclaims, are turned off before it can be read (SECU-1).
  const result = await writeOne(c, slug, scheduled('live'), text, existing ? {} : { inTransaction: () => void revokeLinksAt(c, slug) })
  if (!result.ok) return { ok: false, status: 400, code: 'STORE_ERROR', error: result.error }
  // The editor sent its whole state: a pending revision is superseded.
  const hadPending = deletePendingRevision(c, slug)
  // A new item at an old address of a renamed one: the live item wins.
  if (!existing) forgetRedirectFrom(c, slug)
  if (existing && !isDraftFrontmatter(existing.frontmatter) && !isDraftFrontmatter(fm) && hadPending) {
    const markedUpdated = typeof fm.updated === 'string' && !!fm.updated && fm.updated !== existing.frontmatter.updated
    deps.notify?.({ action: 'publish-changes', collection: c, slug, markedUpdated })
  }
  // A save that ends a schedule (publishing or unpublishing by hand) wakes the scheduler.
  if (before.publishAt !== null || before.unpublishAt !== null) rearmPublishScheduler()
  return {
    ok: true,
    target: 'live',
    stored: result,
    etag: itemEtag(readOne(c, slug)?.updatedAt ?? 0),
    needsRefresh: { collection: c, slug, previousKeys: [existing?.frontmatter?.translationKey] },
  }
}

/** A version is required for the actions below: they act on what the caller saw. */
const versionMissing = (version: unknown) => typeof version !== 'string' || version.trim() === ''

/**
 * Publish an item as stored, the way the editor's Publish does it: a draft
 * goes live (its `draft` flag removed; a future unpublish time stays), and a
 * live item's pending revision goes live ("Publish changes"; `markUpdated`
 * on a post sets its `updated` date to today in the site's time zone). It
 * runs through saveItem, so the body is compiled, posters are imported and
 * the schedule rules hold. `version` (itemEtag) must be the item's current
 * version: what goes live is exactly what the caller saw.
 */
export async function publishItem(
  c: Collection,
  slug: string,
  opts: { version: string; markUpdated?: boolean },
  deps: ItemDeps = {},
): Promise<SaveItemResult> {
  if (!isSafeSlug(slug)) return badRequest('Invalid slug')
  if (versionMissing(opts.version)) return badRequest('The version of the item is required')
  const live = readOne(c, slug)
  if (!live) return notFound()
  const draft = isDraftFrontmatter(live.frontmatter)
  const pending = draft ? null : getPendingRevision(c, slug)
  if (!draft && !pending) {
    return { ok: false, status: 409, code: 'NOTHING_TO_PUBLISH', error: `This ${ITEM_RULES[c].noun} is live and has no saved changes — there is nothing to publish.` }
  }
  const source = pending ?? live
  const frontmatter: Record<string, any> = withoutSchedule(source.frontmatter)
  delete frontmatter.draft
  if (pending && opts.markUpdated === true && c === 'blog') frontmatter.updated = publishDay((deps.now ?? Date.now)())
  return saveItem(c, { slug, frontmatter, body: source.body, target: 'live', ifMatch: opts.version }, deps)
}

/**
 * Unpublish a live item, the way the editor's Unpublish does it: the item
 * goes back to draft with what the editor shows — its pending revision when
 * there is one (a draft never holds one), else the live version — and its
 * schedule ends. Runs through saveItem; `version` as for publishItem.
 */
export async function unpublishItem(c: Collection, slug: string, opts: { version: string }, deps: ItemDeps = {}): Promise<SaveItemResult> {
  if (!isSafeSlug(slug)) return badRequest('Invalid slug')
  if (versionMissing(opts.version)) return badRequest('The version of the item is required')
  const live = readOne(c, slug)
  if (!live) return notFound()
  if (isDraftFrontmatter(live.frontmatter)) return { ok: false, status: 409, code: 'NOT_PUBLISHED', error: `This ${ITEM_RULES[c].noun} is not published` }
  const source = getPendingRevision(c, slug) ?? live
  const frontmatter = { ...withoutSchedule(source.frontmatter), draft: true }
  return saveItem(c, { slug, frontmatter, body: source.body, target: 'live', ifMatch: opts.version }, deps)
}

export type DiscardPendingResult = { ok: true; discarded: boolean; etag: string } | ItemProblem

/**
 * Drop a live item's pending revision (its unpublished changes, and the
 * time they were scheduled to go live). `discarded` is false when there was
 * none. The public pages are unchanged, so nothing is regenerated.
 */
export function discardPending(c: Collection, slug: string, opts: { ifMatch?: string | string[] } = {}, deps: ItemDeps = {}): DiscardPendingResult {
  if (!isSafeSlug(slug)) return badRequest('Invalid slug')
  const one = readOne(c, slug)
  if (!one) return notFound()
  const pending = getPendingRevision(c, slug)
  if (!itemIfMatchAllows(opts.ifMatch, one.updatedAt, pending?.updatedAt)) return versionConflict(one.updatedAt, pending?.updatedAt)
  const discarded = deletePendingRevision(c, slug)
  // Changes scheduled to go live (H5) go with them.
  if (discarded && pending?.frontmatter?.publishAt !== undefined) rearmPublishScheduler()
  if (discarded) deps.notify?.({ action: 'discard-changes', collection: c, slug })
  return { ok: true, discarded, etag: itemEtag(one.updatedAt) }
}

export type DeleteItemResult =
  | { ok: true; deleted: StoreOk & { snapshot?: string }; needsRefresh: CollectionRefresh }
  | ItemProblem

function deleteProblem(error: string): ItemProblem {
  if (error === 'Invalid slug') return badRequest(error)
  return error === 'Not found' ? notFound() : { ok: false, status: 404, code: 'STORE_ERROR', error }
}

/**
 * Delete an item: the live version is kept in the history first (it can be
 * restored from "Recently deleted"), its pending revision is dropped, and
 * its review links end with it — under its old slugs too — never passing to
 * a later item at that address (SECU-1). `ifMatch`, when given, must name
 * the current version (the admin route sends none: the editor asks first).
 */
export async function deleteItem(c: Collection, slug: unknown, opts: { ifMatch?: string | string[] } = {}): Promise<DeleteItemResult> {
  if (typeof slug !== 'string' || !slug) return badRequest('Missing slug')
  const previousKey = isSafeSlug(slug) ? getItem(c, slug)?.frontmatter?.translationKey : undefined
  const linkSlugs = isSafeSlug(slug) ? linkSlugsOf(c, slug) : []
  if (opts.ifMatch !== undefined && isSafeSlug(slug)) {
    const one = readOne(c, slug)
    const pending = one ? getPendingRevision(c, slug) : null
    if (one && !itemIfMatchAllows(opts.ifMatch, one.updatedAt, pending?.updatedAt)) return versionConflict(one.updatedAt, pending?.updatedAt)
  }
  const result = await deleteOne(c, slug)
  if (!result.ok) return deleteProblem(result.error)
  deletePendingRevision(c, slug)
  try {
    revokeItemLinks(c, linkSlugs)
  } catch (err) {
    log.error('delete: could not turn off the review links', { err, collection: c, slug })
  }
  rearmPublishScheduler()
  return { ok: true, deleted: result, needsRefresh: { collection: c, slug, previousKeys: [previousKey] } }
}
