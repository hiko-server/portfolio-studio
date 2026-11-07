import type { NextApiRequest, NextApiResponse } from 'next'
import type { ApiHandler } from './apiHandler'
import { isAdminRequest } from './auth'
import { requireRecentAuth } from './adminAuth/stepUp'
import { sendVersionedJson } from './http'
import { rateLimit } from './rateLimit'
import { revalidatePaths } from './revalidate'
import { emitEditorialEvent, type EditorialEvent } from './editorialEvents'
import { isSafeSlug, itemEtag, itemIfMatchAllows, itemPayload, listAll, readOne, type Collection } from './mdx-admin'
import { getPendingRevision, pendingRevisionIndex } from './pendingRevisions'
import { redirectsTo, removeRedirect } from './redirects'
import { revokeItemLinks } from './review/store'
import { planRename, renameSlug } from './slugRename'
import { parseScheduleBody, withoutSchedule } from './schedule/fields'
import { applySchedule, collectionSchedules } from './schedule/store'
import { rearmPublishScheduler } from './schedule/scheduler'
import { deleteItem, discardPending, saveItem, type ItemProblem } from './contentOps/items'
import { refreshCollection } from './contentOps/refresh'

function checkItemIfMatch(req: NextApiRequest, res: NextApiResponse, liveUpdatedAt: number, pendingUpdatedAt?: number | null): boolean {
  if (itemIfMatchAllows(req.headers['if-match'], liveUpdatedAt, pendingUpdatedAt)) return true
  const etag = itemEtag(liveUpdatedAt, pendingUpdatedAt)
  sendVersionedJson(res, 409, { code: 'VERSION_CONFLICT', error: 'This was changed elsewhere since you loaded it', etag }, etag)
  return false
}

/** The admin API's answer to a refused item write (lib/contentOps/items). */
function sendItemProblem(res: NextApiResponse, p: ItemProblem) {
  switch (p.code) {
    case 'VERSION_CONFLICT':
      return sendVersionedJson(res, 409, { code: p.code, error: p.error, etag: p.etag }, p.etag)
    case 'MDX_INVALID':
      return res.status(422).json(p.problem)
    case 'SLUG_EXISTS':
    case 'NOT_PUBLISHED':
    case 'NOTHING_TO_PUBLISH':
      return res.status(p.status).json({ code: p.code, error: p.error })
    default:
      return res.status(p.status).json({ error: p.error })
  }
}

/**
 * Admin CRUD for a collection (blog posts, case studies), mounted by
 * pages/api/admin/posts and pages/api/admin/work. The write sequences live
 * in lib/contentOps/items; this handler adds the session, rate limits,
 * step-up and the page regeneration (lib/contentOps/refresh).
 *
 *   GET    ?slug=foo  → { slug, frontmatter, body, updatedAt, pending, redirectsFrom, schedule }
 *                       with ETag itemEtag(live, pending); `pending` is the
 *                       unpublished revision of a live item ({ frontmatter,
 *                       body, updatedAt, baseUpdatedAt }) or null;
 *                       `redirectsFrom` the old slugs that redirect here
 *   GET               → { items } (drafts included; `pendingAt` per item)
 *   PUT    { slug, frontmatter, body, create?, target? } (optional If-Match)
 *          target 'live' (default): write the item (a pending revision is
 *            superseded and dropped) → 200 { ok, etag, revalidated }
 *          target 'pending': store the edits of a PUBLISHED item as its
 *            pending revision; the public pages keep the live version and
 *            nothing is regenerated → 200 { ok, pending, etag }
 *          → 409 { code:'SLUG_EXISTS' } when `create` hits an existing slug
 *          → 409 { code:'NOT_PUBLISHED' } for target 'pending' on a draft
 *          → 409 { code:'VERSION_CONFLICT', etag } when If-Match is stale
 *          → 422 { code:'MDX_INVALID', line, column, reason } when the body
 *            does not compile (nothing is written)
 *   POST   { action:'schedule', slug, publishAt, unpublishAt, setDate?, markUpdated? }
 *          (H5, optional If-Match) set or clear when the draft / the pending
 *          changes go live and when the live item unpublishes (ISO instants
 *          or null; lib/schedule) → 200 with the GET ?slug payload and ETag;
 *          400 BAD_TIME / IN_THE_PAST / WINDOW …, 409 NOTHING_TO_PUBLISH
 *   POST   { action:'discard-pending', slug } → drop the pending revision
 *   POST   { action:'rename', slug, to, redirect?, dryRun? } → move the item
 *          to a new slug (lib/slugRename): the old address redirects (308)
 *          unless redirect is false, internal links are rewritten; dryRun
 *          only reports what would change
 *   POST   { action:'remove-redirect', slug, from } → the old address `from`
 *          stops redirecting to `slug`
 *   DELETE ?slug=foo  → { ok, snapshot, revalidated } (snapshot first; needs a
 *                       recent sign-in or step-up, else 403 STEP_UP_REQUIRED)
 */
export function createCollectionApi(c: Collection): ApiHandler {
  return async (req, res) => {
    if (!isAdminRequest(req, res)) return res.status(401).json({ error: 'Unauthorized' })
    res.setHeader('Cache-Control', 'no-store')
    const notify = (event: EditorialEvent) => emitEditorialEvent(event, { req })

    if (req.method === 'GET') {
      const slug = req.query.slug
      if (slug !== undefined) {
        if (typeof slug !== 'string' || !isSafeSlug(slug)) return res.status(400).json({ error: 'Invalid slug' })
        const item = itemPayload(c, slug)
        if (!item) return res.status(404).json({ error: 'Not found' })
        return sendVersionedJson(res, 200, item.body, item.etag)
      }
      const pendingAt = pendingRevisionIndex(c)
      const schedules = collectionSchedules(c)
      return res.status(200).json({
        items: listAll(c).map((i) => ({
          ...i,
          frontmatter: withoutSchedule(i.frontmatter),
          pendingAt: pendingAt.get(i.slug) ?? null,
          schedule: schedules.get(i.slug) ?? null,
        })),
      })
    }

    if (req.method === 'PUT') {
      const rl = rateLimit(req, 30, 10 * 60 * 1000)
      res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
      if (!rl.allowed) return res.status(429).json({ error: 'Too many writes, try later' })
      const { slug, frontmatter, body, create, target } = (req.body || {}) as {
        slug?: unknown
        frontmatter?: unknown
        body?: unknown
        create?: unknown
        target?: unknown
      }
      const out = await saveItem(c, { slug, frontmatter, body, create, target, ifMatch: req.headers['if-match'] }, { notify })
      if (!out.ok) return sendItemProblem(res, out)
      if (out.target === 'pending') return sendVersionedJson(res, 200, { ok: true, pending: out.pending, etag: out.etag }, out.etag)
      const { collection, slug: saved, previousKeys } = out.needsRefresh
      return sendVersionedJson(res, 200, { ...out.stored, etag: out.etag, ...(await refreshCollection(res, collection, saved, previousKeys)) }, out.etag)
    }

    if (req.method === 'POST') {
      const { action, slug } = (req.body || {}) as { action?: unknown; slug?: unknown }
      if (typeof slug !== 'string' || !isSafeSlug(slug)) return res.status(400).json({ error: 'Invalid slug' })

      if (action === 'schedule') {
        const rl = rateLimit(req, 30, 10 * 60 * 1000)
        res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
        if (!rl.allowed) return res.status(429).json({ error: 'Too many writes, try later' })
        const one = readOne(c, slug)
        if (!one) return res.status(404).json({ error: 'Not found' })
        if (!checkItemIfMatch(req, res, one.updatedAt, getPendingRevision(c, slug)?.updatedAt)) return
        const request = parseScheduleBody(req.body as Record<string, unknown>)
        if ('code' in request) return res.status(request.status).json({ code: request.code, error: request.error })
        const out = await applySchedule(c, slug, request)
        if (!out.ok) return res.status(out.status).json({ code: out.code, error: out.error })
        rearmPublishScheduler()
        const item = itemPayload(c, slug)
        if (!item) return res.status(404).json({ error: 'Not found' })
        return sendVersionedJson(res, 200, { ok: true, ...item.body, etag: item.etag, ...(out.r2Warning ? { r2Warning: out.r2Warning } : {}) }, item.etag)
      }

      if (action === 'discard-pending') {
        const out = discardPending(c, slug, { ifMatch: req.headers['if-match'] }, { notify })
        if (!out.ok) return sendItemProblem(res, out)
        return sendVersionedJson(res, 200, { ok: true, discarded: out.discarded, etag: out.etag }, out.etag)
      }

      if (action === 'rename') {
        const { to, redirect, dryRun } = req.body as { to?: unknown; redirect?: unknown; dryRun?: unknown }
        if (typeof to !== 'string') return res.status(400).json({ error: 'Missing new slug' })
        const request = { collection: c, from: slug, to: to.trim().toLowerCase(), redirect: redirect !== false }
        if (dryRun === true) {
          const plan = await planRename(request)
          if (!plan.ok) return res.status(plan.status).json({ code: plan.code, error: plan.error })
          return res.status(200).json(plan)
        }
        const rl = rateLimit(req, 30, 10 * 60 * 1000)
        res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
        if (!rl.allowed) return res.status(429).json({ error: 'Too many writes, try later' })
        const one = readOne(c, slug)
        if (!one) return res.status(404).json({ error: 'Not found' })
        if (!checkItemIfMatch(req, res, one.updatedAt, getPendingRevision(c, slug)?.updatedAt)) return
        const out = await renameSlug(request)
        if (!out.ok) return res.status(out.status).json({ code: out.code, error: out.error })
        notify({ action: 'rename', collection: c, from: slug, to: request.to, redirect: request.redirect, linksRewritten: out.links })
        const failed = await revalidatePaths(res, out.paths)
        const etag = itemEtag(out.updatedAt, getPendingRevision(c, request.to)?.updatedAt)
        return sendVersionedJson(
          res,
          200,
          {
            ok: true,
            slug: request.to,
            etag,
            rewrites: out.rewrites,
            links: out.links,
            redirectsFrom: redirectsTo(c, request.to),
            ...(out.warnings.length ? { r2Warning: out.warnings.join('; ') } : {}),
            revalidated: out.paths.filter((p) => !failed.includes(p)),
            ...(failed.length ? { revalidateFailed: failed } : {}),
          },
          etag,
        )
      }

      if (action === 'remove-redirect') {
        const from = (req.body as { from?: unknown }).from
        if (typeof from !== 'string' || !isSafeSlug(from)) return res.status(400).json({ error: 'Invalid old slug' })
        if (!removeRedirect(c, from, slug)) return res.status(404).json({ error: 'No such redirect' })
        // The old address no longer leads to this item: its review links end there too (SECU-1).
        revokeItemLinks(c, [from])
        notify({ action: 'redirect-removed', collection: c, from, to: slug })
        // The old address answers 404 from now on.
        const failed = await revalidatePaths(res, [`/${c}/${from}`])
        return res.status(200).json({
          ok: true,
          redirectsFrom: redirectsTo(c, slug),
          ...(failed.length ? { revalidateFailed: failed } : {}),
        })
      }

      return res.status(400).json({ error: 'Unknown action' })
    }

    if (req.method === 'DELETE') {
      // Deleting needs a recent sign-in or step-up (403 STEP_UP_REQUIRED).
      if (!requireRecentAuth(req, res)) return
      const out = await deleteItem(c, req.query.slug)
      if (!out.ok) return sendItemProblem(res, out)
      const { collection, slug, previousKeys } = out.needsRefresh
      return res.status(200).json({ ...out.deleted, ...(await refreshCollection(res, collection, slug, previousKeys)) })
    }

    res.setHeader('Allow', 'GET,PUT,POST,DELETE')
    return res.status(405).json({ error: 'Method not allowed' })
  }
}
