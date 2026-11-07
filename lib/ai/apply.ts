import type { NextApiResponse } from 'next'
import { currentSessionVersion } from '../admin'
import { liveSession } from '../adminAuth/sessions'
import { applyFixes, type ExpectedFix } from '../contentHealth/apply'
import { generateVariants } from '../contentHealth/variants'
import { saveCvDoc } from '../contentOps/cv'
import { createDraftItem, saveDraftEdit, type DraftProblem } from '../contentOps/drafts'
import { saveHomeDoc } from '../contentOps/home'
import { deleteItem, discardPending, exactItemVersion, publishItem, restoreItemRows, unpublishItem, type ItemProblem, type SaveItemResult } from '../contentOps/items'
import { saveMediaText } from '../contentOps/media'
import type { OwnerNotice } from '../contentOps/notify'
import { restorePageRows, savePageDoc } from '../contentOps/pages'
import { refreshCollection, refreshCv, refreshHome, refreshPage, refreshRestoredDoc, type Refreshed } from '../contentOps/refresh'
import type { Collection } from '../contentOps/rules'
import { restoreVersion, type VersionKind } from '../contentOps/versions'
import type { EditorialEvent } from '../editorialEvents'
import { ImageRejectedError, storeUpload } from '../imageVariants'
import type { Logger } from '../log'
import { applyDefaultAlt } from '../media/applyAltServer'
import { moveToTrash, restoreFromTrash } from '../media/trash'
import { isSafeSlug, itemEtag, readOne, readPage, versionEtag } from '../mdx-admin'
import { kvEtag } from '../contentStore'
import { readCvDataWithVersion } from '../cvdata'
import { readHomeWithVersion } from '../home'
import { readMediaMeta } from '../media/metaStore'
import { isPageName, pageAdminPath, type PageName } from '../pageNames'
import { getPendingRevision } from '../pendingRevisions'
import { fetchRemoteImage, RemoteImageError } from '../remoteImage'
import { revalidatePaths } from '../revalidate'
import { applySchedule } from '../schedule/store'
import { rearmPublishScheduler } from '../schedule/scheduler'
import { applyTagChange } from '../tagAdminServer'
import { liveGrant } from './access'
import { beginAiWrite, recordEditorSaved, type AiActor } from './audit'
import {
  argsOf,
  beforeStateOf,
  changeRow,
  claimForApply,
  expireIfDue,
  finishClaim,
  markApplied,
  markEditorSaved,
  markRejected,
  markUndone,
  releaseClaim,
  resultOf,
  settleWaiting,
  stateAt,
  type ChangeRow,
} from './changes'
import { getAiDb } from './db'
import { previewSha256, sha256Hex, type BeforeState, type Preview, type WritePlan } from './plans/types'
import { TOOL_LIST_HASH, toolByName } from './registry'
import { aiAccess } from './settings'
import { SCOPES, isWriteTool, type Scope, type ToolContext } from './toolTypes'
import { validateAiWrite } from './validate'
import { inWriteQueue } from './writeQueue'

/**
 * Approving, rejecting and undoing AI changes (SERVER-ONLY, design §5.3).
 * Imported by the cookie routes under /api/admin/ai/changes only — never by
 * a tool, a plan, executeTool or the MCP route (tests/ai-boundary): this is
 * the one module that executes an AI change on the public site, and it does
 * so only for a signed-in owner who saw the card.
 *
 * Approve, in this exact order (non-negotiable):
 *
 *   1. (the route) Strict cookie and the proxy's CSRF guard — a bearer
 *      token never reaches /api/admin/*; a destructive change needs a
 *      recent sign-in (requireRecentAuth);
 *   2. lazy expiry: a waiting change older than 7 days becomes `expired`;
 *   3. the posted preview hash must be the stored one (409 STALE_CARD: the
 *      browser shows an old card);
 *   4. the issuer must still be live: the grant unrevoked, unexpired and on
 *      the current session version, or the assistant's browser session
 *      still signed in; and the change was made under the current session
 *      version. Otherwise the change is `voided`;
 *   5. the stored arguments must still hash to their stored hash (a
 *      mismatch means the database was edited: `failed`);
 *   6. the single-use claim: exactly one approval moves it to `applying`;
 *   7. re-plan: the same plan function on the stored arguments against the
 *      content as it is now, then the same validateAiWrite; the new preview
 *      must hash to the approved one — any difference is a `conflict`, and
 *      nothing is written. There is no rebase. A check the site could not
 *      run just now (CHECK_UNAVAILABLE and the like) writes nothing either,
 *      but the change waits again: nothing is known to have changed;
 *   8. execute the stored arguments through the content services, with the
 *      activity-log row written first (fail closed) and marked approved by
 *      this browser. No model call happens between approve and execute;
 *   9. regenerate the public pages and notify the edge, the editorial
 *      events, the owner's mail, then finish the activity row and store the
 *      result.
 *
 * Steps 6 to 9 run in the single AI-write queue (lib/ai/writeQueue), so no
 * AI write lands between the re-plan and the write.
 */

export const CHANGE_ID_RE = /^ch_[a-z2-7]{16}$/

export type DecisionContext = {
  session: { id: string; device: string | null }
  /** The approving browser's network (the activity row). */
  origin: { ipPrefix: string | null; country: string | null }
  requestId: string | null
  log: Logger
  /** The route's real response: page regeneration goes through Next's own revalidation. */
  res: NextApiResponse
  /** Editorial events, with the request (lib/editorialEvents emitEditorialEvent). */
  notify: (event: EditorialEvent) => void
  /** The owner's mail (lib/contentOps/notify ownerMail). */
  mail: (notice: OwnerNotice) => void
  /** Who approved, for the owner's CV mail. */
  ownerEmail?: string
  now?: () => number
}

export type DecisionFailure = { ok: false; status: 400 | 403 | 404 | 409 | 500 | 503; code: string; message: string; state?: string }
export type ApproveResult = { ok: true; state: 'applied'; result: Record<string, unknown> } | DecisionFailure

const fail = (status: DecisionFailure['status'], code: string, message: string, state?: string): DecisionFailure => ({ ok: false, status, code, message, ...(state ? { state } : {}) })

/**
 * The verified actor a change was made by, as its row records it. The
 * assistant's issuer is the session that started its run, recorded on the
 * row (ai.db v2), so a proposal stays approvable after its conversation is
 * deleted; a row from before v2 finds it through its run.
 */
function actorOf(row: ChangeRow): AiActor {
  if (row.actor_kind === 'mcp') return { kind: 'mcp', grantId: row.actor_id, label: row.actor_label }
  const sessionId =
    row.issuer_session ?? (getAiDb().prepare('SELECT session_id FROM ai_runs WHERE id = ?').get(row.actor_id) as { session_id: string } | undefined)?.session_id ?? null
  return { kind: 'assistant', runId: row.actor_id, conversationId: row.conversation_id ?? '', sessionId, provider: row.provider ?? '', model: row.model ?? '' }
}

/** The scopes the issuer holds now (a grant's, or all three for the assistant), or null when it no longer has access. */
function issuerScopes(row: ChangeRow, actor: AiActor, now: number): ReadonlySet<Scope> | null {
  if (row.issuer_version !== currentSessionVersion()) return null
  if (actor.kind === 'mcp') {
    const grant = liveGrant(actor.grantId, now)
    return grant ? new Set(grant.scopes) : null
  }
  return actor.sessionId && liveSession(actor.sessionId, now) ? new Set(SCOPES) : null
}

/** Run the change's plan again on its stored arguments and build the preview exactly as the proposal did. */
async function replan(row: ChangeRow, args: Record<string, unknown>, ctx: ToolContext): Promise<{ ok: true; plan: WritePlan; preview: Preview } | { ok: false; code: string; message: string }> {
  const tool = toolByName(row.tool)
  if (!tool || !isWriteTool(tool)) return { ok: false, code: 'UNKNOWN_TOOL', message: 'The tool that proposed this no longer exists.' }
  const planned = await tool.plan(args as never, ctx)
  if ('ok' in planned) return { ok: false, code: planned.code, message: planned.message }
  if (planned.kind !== row.kind) return { ok: false, code: 'KIND_CHANGED', message: 'This would now be a different kind of change.' }
  const checked = await validateAiWrite(planned.check, { signal: ctx.signal })
  if (!checked.ok) return { ok: false, code: checked.code, message: checked.message }
  return { ok: true, plan: planned, preview: { ...planned.preview, newLinks: checked.newLinks, newEmbeds: checked.newEmbeds, zeroWidth: checked.zeroWidth } }
}

type Executed =
  | { ok: true; result: Record<string, unknown>; refresh: () => Promise<Refreshed | null> }
  /** `conflict`: refused before anything was written because the content moved; else nothing written for another reason. */
  | { ok: false; written: false; conflict: boolean; code: string; message: string }

const noRefresh = async () => null
const notWritten = (code: string, message: string, conflict = false): Executed => ({ ok: false, written: false, conflict, code, message })

function itemProblem(p: ItemProblem | DraftProblem): Executed {
  const code = 'code' in p ? p.code : 'FAILED'
  const message = 'error' in p && typeof p.error === 'string' ? p.error : 'The change could not be saved.'
  return notWritten(code, message, code === 'VERSION_CONFLICT' || code === 'NOTHING_TO_PUBLISH' || code === 'NOT_PUBLISHED')
}

const itemVersionNow = (c: Collection, slug: string) => {
  const one = readOne(c, slug)
  return one ? itemEtag(one.updatedAt, getPendingRevision(c, slug)?.updatedAt) : itemEtag(0)
}

/** Execute one re-planned change through the content services. Throws only on an unexpected error (the write may be partial). */
async function execute(plan: WritePlan, args: Record<string, any>, ctx: DecisionContext, notices: OwnerNotice[], events: EditorialEvent[], now: number): Promise<Executed> {
  const res = ctx.res
  const notify = (e: EditorialEvent) => events.push(e)
  const mail = (n: OwnerNotice) => notices.push(n)
  const c = args.collection as Collection
  switch (plan.kind) {
    case 'item.create': {
      const out = await createDraftItem(c, { slug: args.slug, frontmatter: args.frontmatter, body: args.body }, { now })
      if (!out.ok) return itemProblem(out as DraftProblem)
      return { ok: true, result: { version: out.version, savedAs: 'draft' }, refresh: noRefresh }
    }
    case 'item.edit-draft':
    case 'item.edit-pending':
    case 'item.edit-held': {
      const out = await saveDraftEdit(
        c,
        { slug: args.slug, baseVersion: args.base_version, body: args.body, frontmatterPatch: args.frontmatter_patch, removeFrontmatter: args.remove_frontmatter },
        { allowHeld: plan.kind === 'item.edit-held', now },
      )
      if (!out.ok) return itemProblem(out as DraftProblem)
      return { ok: true, result: { version: out.version, savedAs: out.target === 'pending' ? 'unpublished_changes' : 'draft' }, refresh: noRefresh }
    }
    case 'media.texts': {
      const out = await saveMediaText({ name: args.name, texts: args.texts, expectedUpdatedAt: args.expected_updated_at })
      if (!out.ok) return notWritten(out.code, out.error, out.code === 'CONFLICT')
      return { ok: true, result: { version: String(out.meta?.updatedAt ?? 0), savedAs: 'texts' }, refresh: noRefresh }
    }
    case 'item.publish':
    case 'item.unpublish': {
      const out: SaveItemResult =
        plan.kind === 'item.publish'
          ? await publishItem(c, args.slug, { version: args.base_version, markUpdated: args.mark_updated === true, ...(typeof args.updated_on === 'string' ? { updatedOn: args.updated_on } : {}) }, { notify, now: () => now })
          : await unpublishItem(c, args.slug, { version: args.base_version }, { notify, now: () => now })
      if (!out.ok) return itemProblem(out)
      const refresh = out.target === 'live' ? () => refreshCollection(res, out.needsRefresh.collection, out.needsRefresh.slug, out.needsRefresh.previousKeys) : noRefresh
      return { ok: true, result: { version: itemVersionNow(c, args.slug) }, refresh }
    }
    case 'item.schedule':
    case 'item.unschedule': {
      if (exactItemVersion(args.base_version) !== itemVersionNow(c, args.slug)) return notWritten('VERSION_CONFLICT', 'The item changed since this was proposed.', true)
      const publishAt = typeof args.publish_at === 'string' ? Date.parse(args.publish_at) : null
      const unpublishAt = typeof args.unpublish_at === 'string' ? Date.parse(args.unpublish_at) : null
      const out = await applySchedule(c, args.slug, { publishAt, unpublishAt, markUpdated: args.mark_updated === true }, now)
      if (!out.ok) return notWritten(out.code, out.error, out.status === 409)
      rearmPublishScheduler()
      return { ok: true, result: { version: itemVersionNow(c, args.slug) }, refresh: noRefresh }
    }
    case 'item.discard-changes': {
      const out = discardPending(c, args.slug, { version: args.base_version }, { notify })
      if (!out.ok) return itemProblem(out)
      return { ok: true, result: { version: itemVersionNow(c, args.slug) }, refresh: noRefresh }
    }
    case 'page.edit': {
      const name = args.name as PageName
      const fm = (plan.check.kind === 'item' ? plan.check.frontmatter : {}) as Record<string, unknown>
      const out = await savePageDoc({ name, frontmatter: fm, body: args.body, version: args.base_version })
      if (!out.ok) return notWritten(out.code, out.code === 'MDX_INVALID' ? out.problem.error : out.error, out.code === 'VERSION_CONFLICT')
      return { ok: true, result: { version: out.etag }, refresh: () => refreshPage(res, name) }
    }
    case 'home.edit': {
      const out = await saveHomeDoc(plan.exec?.doc, { version: args.base_version }, { log: ctx.log, notify: mail })
      if (!out.ok) return notWritten(out.code, out.code === 'CONFLICT' ? 'The home page changed since this was proposed.' : out.error, out.code === 'CONFLICT')
      return { ok: true, result: { version: out.etag }, refresh: out.unchanged ? noRefresh : () => refreshHome(res) }
    }
    case 'cv.edit': {
      const doc = plan.exec?.doc as { en: unknown; zh: unknown }
      const out = await saveCvDoc({ en: doc.en, zh: doc.zh }, { version: args.base_version }, { log: ctx.log, notify: mail, actor: ctx.ownerEmail })
      if (!out.ok) return notWritten(out.code, out.code === 'CONFLICT' ? 'The CV changed since this was proposed.' : out.error, out.code === 'CONFLICT')
      return { ok: true, result: { version: out.etag }, refresh: out.unchanged ? noRefresh : () => refreshCv(res, out.nav) }
    }
    case 'tag.change': {
      const out = await applyTagChange({ collection: c, from: args.from, to: args.to })
      if (!out.ok) return notWritten('INVALID_INPUT', out.error)
      if (out.items.length) {
        const merge = (args.from as string[]).length > 1
        notify({ action: merge ? 'tag-merge' : 'tag-rename', collection: c, from: args.from, to: String(args.to).trim(), items: out.items.length })
      }
      return {
        ok: true,
        result: { items: out.items.map((i) => i.slug), ...(out.warnings.length ? { warnings: out.warnings } : {}) },
        refresh: async () => {
          const failed = out.paths.length ? await revalidatePaths(res, out.paths) : []
          return { revalidated: out.paths.filter((p) => !failed.includes(p)), ...(failed.length ? { revalidateFailed: failed } : {}) }
        },
      }
    }
    case 'item.restore':
    case 'page.restore':
    case 'home.restore':
    case 'cv.restore': {
      const kind = args.collection as VersionKind
      const out = await restoreVersion(kind, typeof args.ref === 'string' ? args.ref : kind, args.filename, { version: args.base_version }, { log: ctx.log })
      if (!out.ok) return notWritten(out.status === 409 ? 'VERSION_CONFLICT' : 'FAILED', out.error, out.status === 409)
      const r = out.refresh
      const refresh =
        r.kind === 'item' ? () => refreshCollection(res, r.collection, r.slug) : r.kind === 'page' ? () => refreshPage(res, r.name) : () => refreshRestoredDoc(res, r.type, r.nav)
      return { ok: true, result: { version: kind === 'blog' || kind === 'work' ? itemVersionNow(kind, String(args.ref)) : out.etag }, refresh }
    }
    case 'health.fix': {
      const fixes = (args.fixes as ExpectedFix[]).map((f) => ({ ...f }))
      // applyFixes regenerates the pages itself, with the route's response, like the Content health page.
      const out = await applyFixes(res, fixes, { log: ctx.log, generateVariants: (names) => generateVariants(names, ctx.log), now: () => now })
      if (out.applied === 0) {
        const conflict = out.results.some((r) => r.code === 'VERSION_CONFLICT')
        return notWritten(conflict ? 'VERSION_CONFLICT' : 'FAILED', out.results.find((r) => !r.ok)?.error ?? 'Nothing left to fix.', conflict)
      }
      const failed = out.results.filter((r) => !r.ok).map((r) => ({ id: r.id, code: r.code ?? 'FAILED', error: r.error ?? '' }))
      return {
        ok: true,
        result: { applied: out.applied, ...(failed.length ? { failed } : {}) },
        refresh: async () => ({ revalidated: out.revalidated, ...(out.revalidateFailed ? { revalidateFailed: out.revalidateFailed } : {}) }),
      }
    }
    case 'media.apply-alt': {
      const out = await applyDefaultAlt(String(args.name), args.expected)
      if (!out.ok) return notWritten(out.status === 409 ? 'CONFLICT' : 'FAILED', out.error, out.status === 409)
      return {
        ok: true,
        result: { places: out.places, ...(out.skipped.length ? { skipped: out.skipped.map((s) => `${s.kind}/${s.ref}`) } : {}), ...(out.warnings.length ? { warnings: out.warnings } : {}) },
        refresh: async () => {
          const failed = out.paths.length ? await revalidatePaths(res, out.paths) : []
          return { revalidated: out.paths.filter((p) => !failed.includes(p)), ...(failed.length ? { revalidateFailed: failed } : {}) }
        },
      }
    }
    case 'media.import': {
      let remote
      try {
        remote = await fetchRemoteImage(args.url)
      } catch (err) {
        if (err instanceof RemoteImageError) return notWritten(err.code, err.message)
        throw err
      }
      let stored
      try {
        stored = await storeUpload(remote.buf, remote.mime, remote.name)
      } catch (err) {
        if (err instanceof ImageRejectedError) return notWritten(err.code, err.message)
        throw err
      }
      return { ok: true, result: { name: stored.name, url: stored.url, width: stored.width, height: stored.height }, refresh: noRefresh }
    }
    case 'item.delete': {
      const dc: Collection = args.target === 'post' ? 'blog' : 'work'
      const out = await deleteItem(dc, args.ref, { version: args.base_version })
      if (!out.ok) return itemProblem(out)
      const { collection, slug, previousKeys } = out.needsRefresh
      return { ok: true, result: { version: itemEtag(0), snapshot: out.deleted.snapshot ?? null }, refresh: () => refreshCollection(res, collection, slug, previousKeys) }
    }
    case 'media.trash': {
      const out = await moveToTrash(String(args.ref))
      if (!out.ok) return notWritten(out.code, out.error, out.code === 'IN_USE')
      return { ok: true, result: { name: out.name, ...(out.r2Warning ? { r2Warning: out.r2Warning } : {}) }, refresh: noRefresh }
    }
    default:
      return notWritten('UNKNOWN_KIND', 'This kind of change cannot be applied.')
  }
}

/**
 * Kinds whose approval changes what visitors see at once (a held edit, a schedule or an import does not: the first
 * goes public when its schedule runs, if ever; the others change no page now).
 */
const PUBLIC_AT_APPROVAL = new Set(['item.publish', 'item.unpublish', 'item.restore', 'item.delete', 'page.edit', 'page.restore', 'home.edit', 'home.restore', 'cv.edit', 'cv.restore', 'tag.change', 'health.fix', 'media.apply-alt'])

/**
 * Re-plan refusals about the site rather than the content: the change waits
 * again (the claim is released) and the owner can approve it once more,
 * as when the activity log is unavailable. Every other refusal is a
 * `conflict`.
 */
const RETRY_LATER = new Set(['CHECK_UNAVAILABLE', 'UNAVAILABLE', 'AUDIT_UNAVAILABLE'])

/** The public addresses an applied change reached (get_change's public_urls). */
function publicUrlsOf(plan: WritePlan): string[] {
  if (!PUBLIC_AT_APPROVAL.has(plan.kind)) return []
  return Array.from(new Set(plan.preview.documents.map((d) => d.publicUrl).filter((u): u is string => typeof u === 'string'))).slice(0, 50)
}

/**
 * Approve a waiting change (§5.3), for the signed-in owner. `recentAuth`:
 * the route ran requireRecentAuth (a destructive change needs it; checked
 * here too).
 */
export async function approveChange(id: string, postedHash: unknown, ctx: DecisionContext & { recentAuth: boolean }): Promise<ApproveResult> {
  const clock = ctx.now ?? Date.now
  const now = clock()
  if (!CHANGE_ID_RE.test(id)) return fail(404, 'NOT_FOUND', 'No such change.')
  const row = changeRow(id)
  if (!row) return fail(404, 'NOT_FOUND', 'No such change.')
  if (row.risk === 'destructive' && !ctx.recentAuth) return fail(403, 'STEP_UP_REQUIRED', 'Confirm it is you to approve this change.')
  // 2. Lazy expiry.
  if (expireIfDue(id, now)) return fail(409, 'EXPIRED', 'This change waited more than 7 days and expired.', 'expired')
  const state = stateAt(row, now)
  if (state !== 'waiting') return fail(409, 'NOT_WAITING', `This change is ${state}.`, state)
  // 3. The card the owner saw.
  if (typeof postedHash !== 'string' || postedHash !== row.preview_sha256) return fail(409, 'STALE_CARD', 'This card is out of date: reload it.', 'waiting')
  // 4. The issuer is still live.
  const access = aiAccess()
  if (!access.on) {
    settleWaiting(id, 'voided', 'ACCESS_OFF', now)
    return fail(409, 'VOIDED', 'AI access is turned off, so nothing it proposed can be applied.', 'voided')
  }
  const actor = actorOf(row)
  const scopes = issuerScopes(row, actor, now)
  if (!scopes) {
    settleWaiting(id, 'voided', 'ISSUER_ENDED', now)
    return fail(409, 'VOIDED', 'The app that proposed this no longer has access.', 'voided')
  }
  // 5. The stored arguments are the ones hashed at proposal.
  const args = argsOf(row)
  if (!args || sha256Hex(row.args_json ?? '') !== row.args_sha256) {
    settleWaiting(id, 'failed', 'ARGS_CHANGED', now)
    return fail(409, 'FAILED', 'The stored change does not match what was proposed, so it was not applied.', 'failed')
  }
  // 6. Single use.
  if (!claimForApply(id, ctx.session.id, now)) return fail(409, 'NOT_WAITING', 'This change was decided elsewhere.', stateAt(changeRow(id) ?? row, clock()))

  return inWriteQueue(async (): Promise<ApproveResult> => {
    const at = clock()
    // 7. Re-plan on the stored arguments against the content as it is now; the preview must be the one approved.
    const toolCtx: ToolContext = { actor, scopes, log: ctx.log, signal: new AbortController().signal, requestId: ctx.requestId, now: at }
    let again: Awaited<ReturnType<typeof replan>>
    try {
      again = await replan(row, args, toolCtx)
    } catch (err) {
      ctx.log.error('AI approval: the re-plan failed', { changeId: id, err })
      finishClaim(id, 'failed', 'REPLAN_FAILED', clock())
      return fail(500, 'FAILED', 'The change could not be checked again, so nothing was written.', 'failed')
    }
    if (!again.ok && RETRY_LATER.has(again.code)) {
      // The site could not check it just now (the MDX check's worker, a store): nothing is known to have changed.
      releaseClaim(id)
      return fail(503, again.code, 'The site could not check this change again just now, so nothing was written. Try again in a minute.', 'waiting')
    }
    if (!again.ok || previewSha256(again.preview) !== row.preview_sha256) {
      finishClaim(id, 'conflict', again.ok ? 'PREVIEW_CHANGED' : again.code, clock())
      return fail(409, 'CONFLICT', 'This changed after it was proposed. Nothing was written.', 'conflict')
    }
    const plan = again.plan
    // 8. The activity row first, fail closed, as approved by this browser.
    const begun = beginAiWrite(
      {
        actor,
        origin: ctx.origin,
        surfaceRoute: 'admin/ai/changes',
        tool: row.tool,
        argsSha256: row.args_sha256,
        toolListHash: TOOL_LIST_HASH,
        requestId: ctx.requestId,
        changeId: id,
        approval: { sessionId: ctx.session.id, device: ctx.session.device, at },
        write: plan.audit,
      },
      at,
    )
    if (!begun.ok) {
      releaseClaim(id)
      return fail(503, 'AUDIT_UNAVAILABLE', 'The activity log could not record this, so nothing was written. Try again.', 'waiting')
    }
    const notices: OwnerNotice[] = []
    const events: EditorialEvent[] = []
    let done: Executed
    try {
      done = await begun.intent.run(() => execute(plan, args as Record<string, any>, ctx, notices, events, at))
    } catch (err) {
      // Part-way: the activity row stays at status 0 (it reads as interrupted), the change reads as failed.
      ctx.log.error('AI approval: the write failed', { changeId: id, kind: row.kind, err })
      finishClaim(id, 'failed', 'WRITE_FAILED', clock())
      return fail(500, 'FAILED', 'The change could not be written completely. Check the item before trying again.', 'failed')
    }
    if (!done.ok) {
      begun.intent.discard()
      finishClaim(id, done.conflict ? 'conflict' : 'failed', done.code, clock())
      return fail(409, done.conflict ? 'CONFLICT' : 'FAILED', done.message, done.conflict ? 'conflict' : 'failed')
    }
    // 9. The public pages and the edge, the editorial events, the owner's mail, then the activity row and the result.
    let refreshed: Refreshed | null = null
    try {
      refreshed = await done.refresh()
    } catch (err) {
      ctx.log.warn('AI approval: page regeneration failed', { changeId: id, err })
    }
    for (const e of events) ctx.notify(e)
    for (const n of notices) ctx.mail(n)
    begun.intent.finish(200)
    const result = { ...done.result, publicUrls: publicUrlsOf(plan), editUrl: plan.editUrl, approvedOn: ctx.session.device, ...(refreshed ?? {}) }
    markApplied(id, result, clock())
    return { ok: true, state: 'applied', result }
  })
}

export type RejectResult = { ok: true; state: 'rejected' } | DecisionFailure

/** Reject a waiting change, optionally with a note the issuer reads (get_change). */
export function rejectChange(id: string, note: unknown, session: { id: string }, now = Date.now()): RejectResult {
  if (!CHANGE_ID_RE.test(id)) return fail(404, 'NOT_FOUND', 'No such change.')
  const row = changeRow(id)
  if (!row) return fail(404, 'NOT_FOUND', 'No such change.')
  if (note !== undefined && note !== null && typeof note !== 'string') return fail(400, 'INVALID_NOTE', 'The note must be text.')
  const clean = typeof note === 'string' ? note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]|[\u{e0000}-\u{e007f}]/gu, '').trim().slice(0, 500) : ''
  if (expireIfDue(id, now)) return fail(409, 'EXPIRED', 'This change expired.', 'expired')
  if (!markRejected(id, clean || null, session.id, now)) {
    const state = stateAt(changeRow(id) ?? row, now)
    return fail(409, 'NOT_WAITING', `This change is ${state}.`, state)
  }
  return { ok: true, state: 'rejected' }
}

// ── Undo ──────────────────────────────────────────────────────────────────

/** Kinds with a one-click undo: a single target whose before-state comes back (§4.2). */
const UNDO_KINDS = new Set([
  'item.create',
  'item.edit-draft',
  'item.edit-pending',
  'item.edit-held',
  'media.texts',
  'item.publish',
  'item.unpublish',
  'item.schedule',
  'item.unschedule',
  'item.discard-changes',
  'item.restore',
  'page.edit',
  'page.restore',
  'home.edit',
  'home.restore',
  'cv.edit',
  'cv.restore',
  'media.import',
  'item.delete',
  'media.trash',
])

/** The target's version as the change's result recorded it, now (null when it cannot be read). */
function currentVersionOf(row: ChangeRow): string | null {
  const t = row.target_kind
  if (t === 'blog' || t === 'work') return isSafeSlug(row.target_ref) ? itemVersionNow(t, row.target_ref) : null
  if (t === 'page') return versionEtag(readPage(row.target_ref as PageName).updatedAt)
  if (t === 'home') return kvEtag(readHomeWithVersion().version)
  if (t === 'cv') return kvEtag(readCvDataWithVersion().version)
  if (t === 'media' && row.kind === 'media.texts') return String(readMediaMeta().doc.items[row.target_ref]?.updatedAt ?? 0)
  return null
}

/** The target's version now, as a change's result would record it (null when it cannot be read). */
export function currentVersionFor(targetKind: string, targetRef: string): string | null {
  try {
    return currentVersionOf({ target_kind: targetKind, target_ref: targetRef, kind: '' } as ChangeRow)
  } catch {
    return null
  }
}

export type UndoAvailability = { ok: true } | { ok: false; code: 'NO_UNDO' | 'NOT_APPLIED' | 'CHANGED_SINCE' | 'PRUNED' | 'SAVED_IN_EDITOR'; message: string }

/** Can this change be undone now? (The card shows the answer before the click.) */
export function undoAvailability(row: ChangeRow): UndoAvailability {
  // The owner's own save in the editor wrote it, with whatever else they changed: its history holds the version before.
  if (row.state === 'applied' && resultOf(row).savedInEditor === true) return { ok: false, code: 'SAVED_IN_EDITOR', message: 'Saved in the editor: its history keeps the version before.' }
  if (!UNDO_KINDS.has(row.kind)) return { ok: false, code: 'NO_UNDO', message: 'No single undo: each document has its own history.' }
  if (row.state !== 'applied') return { ok: false, code: 'NOT_APPLIED', message: 'Only an applied change can be undone.' }
  const result = resultOf(row)
  // An import is undone while the image is unused, a trashed image while it is in the trash: their own checks say so.
  if (row.kind === 'media.import' || row.kind === 'media.trash') return { ok: true }
  const version = currentVersionOf(row)
  if (version === null || version !== result.version) return { ok: false, code: 'CHANGED_SINCE', message: 'Changed since. Open the history.' }
  return { ok: true }
}

export type UndoResult = { ok: true; state: 'undone'; refreshed: Refreshed | null } | DecisionFailure

/**
 * Undo an applied change: the state it replaced comes back through an
 * ordinary write, while the target is still at the version the change
 * wrote ("Changed since" otherwise). The owner's own action: no step-up
 * (undoing an AI draft deletes only the version the AI created).
 */
export async function undoChange(id: string, ctx: DecisionContext): Promise<UndoResult> {
  const now = (ctx.now ?? Date.now)()
  if (!CHANGE_ID_RE.test(id)) return fail(404, 'NOT_FOUND', 'No such change.')
  const row = changeRow(id)
  if (!row) return fail(404, 'NOT_FOUND', 'No such change.')
  const can = undoAvailability(row)
  if (!can.ok) return fail(409, can.code, can.message, row.state)
  const before = beforeStateOf(id)
  if (!before) return fail(409, 'PRUNED', 'The state before this change is no longer kept. Open the history.', row.state)
  const result = resultOf(row)
  return inWriteQueue(async (): Promise<UndoResult> => {
    const out = await undo(row, before, result, ctx)
    if (!out.ok) return out
    let refreshed: Refreshed | null = null
    try {
      refreshed = await out.refresh()
    } catch (err) {
      ctx.log.warn('AI undo: page regeneration failed', { changeId: id, err })
    }
    markUndone(id, now)
    return { ok: true, state: 'undone', refreshed }
  })
}

type Undone = { ok: true; refresh: () => Promise<Refreshed | null> } | DecisionFailure

const changedSince = (message = 'Changed since. Open the history.') => fail(409, 'CHANGED_SINCE', message, 'applied')

async function undo(row: ChangeRow, before: BeforeState, result: Record<string, any>, ctx: DecisionContext): Promise<Undone> {
  const res = ctx.res
  const version = typeof result.version === 'string' ? result.version : ''
  if (before.kind === 'item') {
    if (row.kind === 'item.delete') {
      // The item comes back exactly as it was — its live row and its unpublished changes, from the before-state
      // (the history keeps the snapshot the delete took too) — while the address is still free.
      if (readOne(before.collection, before.slug)) return changedSince('Something new is at that address now. Open the history.')
      const out = await restoreItemRows(before.collection, before.slug, { live: before.live, pending: before.pending }, { version: itemEtag(0) })
      if (!out.ok) return out.code === 'VERSION_CONFLICT' ? changedSince() : fail(409, 'FAILED', out.error, 'applied')
      return { ok: true, refresh: () => refreshCollection(res, before.collection, before.slug) }
    }
    const out = await restoreItemRows(before.collection, before.slug, { live: before.live, pending: before.pending }, { version })
    if (!out.ok) return out.code === 'VERSION_CONFLICT' ? changedSince() : fail(409, 'FAILED', out.error, 'applied')
    const wasPublic = before.live !== null && !before.live.frontmatter?.draft
    const draftOnly = !wasPublic && row.risk === 'draft'
    const { collection, slug, previousKeys } = out.needsRefresh
    return { ok: true, refresh: draftOnly ? async () => null : () => refreshCollection(res, collection, slug, previousKeys) }
  }
  if (before.kind === 'page') {
    const name = before.name as PageName
    const out = await restorePageRows(name, before.page, { version })
    if (!out.ok) return out.code === 'VERSION_CONFLICT' ? changedSince() : fail(409, 'FAILED', 'error' in out ? out.error : 'The page could not be restored.', 'applied')
    return { ok: true, refresh: () => refreshPage(res, name) }
  }
  if (before.kind === 'doc') {
    if (before.doc === 'home') {
      const out = await saveHomeDoc(before.value, { version }, { log: ctx.log, notify: ctx.mail })
      if (!out.ok) return out.code === 'CONFLICT' ? changedSince() : fail(409, 'FAILED', out.code === 'INVALID_HOME' ? out.error : 'error' in out ? out.error : 'The home page could not be restored.', 'applied')
      return { ok: true, refresh: out.unchanged ? async () => null : () => refreshHome(res) }
    }
    const doc = before.value as { en: unknown; zh: unknown }
    const out = await saveCvDoc({ en: doc.en, zh: doc.zh }, { version }, { log: ctx.log, notify: ctx.mail, actor: ctx.ownerEmail })
    if (!out.ok) return out.code === 'CONFLICT' ? changedSince() : fail(409, 'FAILED', 'error' in out ? out.error : 'The CV could not be restored.', 'applied')
    return { ok: true, refresh: out.unchanged ? async () => null : () => refreshCv(res, out.nav) }
  }
  if (before.kind === 'media') {
    const texts = before.texts ?? { alt: '', altZh: '', caption: '', captionZh: '' }
    const out = await saveMediaText({ name: before.name, texts, expectedUpdatedAt: Number(version) })
    if (!out.ok) return out.code === 'CONFLICT' ? changedSince() : fail(409, 'FAILED', out.error, 'applied')
    return { ok: true, refresh: async () => null }
  }
  if (row.kind === 'media.import') {
    const name = typeof result.name === 'string' ? result.name : ''
    const out = await moveToTrash(name)
    if (!out.ok) return out.code === 'IN_USE' ? changedSince('The imported image is used now: remove it from those places first.') : fail(409, 'FAILED', out.error, 'applied')
    return { ok: true, refresh: async () => null }
  }
  if (row.kind === 'media.trash' && before.kind === 'upload') {
    const out = await restoreFromTrash(before.name)
    if (!out.ok) return out.code === 'EXISTS' ? changedSince('An upload with that name exists again.') : fail(409, 'FAILED', out.error, 'applied')
    return { ok: true, refresh: async () => null }
  }
  return fail(409, 'NO_UNDO', 'No single undo: each document has its own history.', row.state)
}

// ── Saved in the editor (§7.8) ────────────────────────────────────────────

/**
 * Kinds an editor can carry to a save: a suggestion sent to the open editor,
 * and the waiting MDX and page edits "Open in editor" puts there (§8.2).
 */
export const EDITOR_SAVE_KINDS: ReadonlySet<string> = new Set(['item.editor', 'page.editor', 'item.edit-draft', 'item.edit-pending', 'item.edit-held', 'page.edit'])

const SAVED_VERSION_RE = /^[A-Za-z0-9"._:/-]{1,80}$/

export type EditorSavedResult = { ok: true; state: 'applied'; audited: boolean } | DecisionFailure

/**
 * The owner saved, in the editor, a version that carries this change: POST
 * changes/<id>/editor-saved { version } after a successful save (§7.8). The
 * save itself went through the ordinary save route, untouched; this only
 * attributes it. `version` must be the target's version now — what that
 * save produced — so attribution can never name another version. The change
 * becomes `applied` with that version (so "Contains AI edits" and "AI wrote
 * to this before" see it), and the activity log records "AI-suggested ·
 * <who> · saved on <browser>", linked to the version the save replaced, so
 * the item's history says so. If this fails, the save still stands and only
 * the attribution is lost.
 */
export function editorSaved(
  id: string,
  version: unknown,
  ctx: { session: { id: string; device: string | null }; origin: { ipPrefix: string | null; country: string | null }; requestId: string | null; log: Logger; now?: () => number },
): EditorSavedResult {
  const now = (ctx.now ?? Date.now)()
  if (!CHANGE_ID_RE.test(id)) return fail(404, 'NOT_FOUND', 'No such change.')
  const row = changeRow(id)
  if (!row) return fail(404, 'NOT_FOUND', 'No such change.')
  if (typeof version !== 'string' || !SAVED_VERSION_RE.test(version)) return fail(400, 'INVALID_VERSION', 'Send the version the save answered.')
  if (!EDITOR_SAVE_KINDS.has(row.kind)) return fail(409, 'NOT_EDITABLE', 'This change is not one an editor saves.', row.state)
  expireIfDue(id, now)
  const state = stateAt(changeRow(id) ?? row, now)
  if (state !== 'in_editor' && state !== 'waiting') return fail(409, 'NOT_OPEN', `This change is ${state}.`, state)
  if (currentVersionOf(row) !== version) return fail(409, 'VERSION_MOVED', 'The document changed again after that save, so the save was not attributed.', state)
  const result = { version, savedInEditor: true, savedOn: ctx.session.device, editUrl: (resultOf(row).editUrl as string | undefined) ?? editUrlOf(row), publicUrls: [] as string[] }
  if (!markEditorSaved(id, result, ctx.session.id, now)) {
    const after = stateAt(changeRow(id) ?? row, now)
    return fail(409, 'NOT_OPEN', `This change is ${after}.`, after)
  }
  let audited = false
  try {
    audited = recordEditorSaved({ row, session: ctx.session, origin: ctx.origin, requestId: ctx.requestId }, now)
  } catch (err) {
    ctx.log.warn('AI editor save: the activity row could not be written', { changeId: id, err })
  }
  return { ok: true, state: 'applied', audited }
}

/** Where a change's target is edited (its card's history link). */
function editUrlOf(row: Pick<ChangeRow, 'target_kind' | 'target_ref'>): string | null {
  if (row.target_kind === 'blog' || row.target_kind === 'work') return `/admin/${row.target_kind}/edit?slug=${encodeURIComponent(row.target_ref)}`
  if (row.target_kind === 'page' && isPageName(row.target_ref)) return pageAdminPath(row.target_ref)
  return null
}
