import type { Collection } from '../../contentOps/rules'
import { checkSchedule, itemSchedule, publishDay, withoutSchedule } from '../../schedule/fields'
import { parseInstant, toInstantString } from '../../schedule/time'
import type { ToolContext, ToolRefusal } from '../toolTypes'
import { itemBefore, itemEditUrl, itemPublicPaths, itemState, itemText, needsDraftAccess, noun, refuse, versionProblem, type ItemState } from './common'
import type { CheckedDocument, PreviewDocument, WritePlan } from './types'

/**
 * Plan of `propose_publishing` (pure, design §4.2): publish, unpublish,
 * schedule, clear the schedule of, or discard the unpublished changes of a
 * post or case study — nothing happens until the owner approves.
 *
 * The preview shows what changes publicly: the text visitors read now and
 * the text they will read (an empty side when nothing is public), and the
 * schedule before and after. Its `args` are what an approval executes; the
 * same function runs again on them at approval (lib/ai/apply), so a version
 * that moved, a schedule that changed or a time that passed is a conflict.
 * The day a publish marked updated writes is chosen at the proposal and
 * stored with it (`updated_on`, never sent by a caller): the card shows that
 * day, and an approval on a later day writes the same one.
 */

export const PUBLISHING_ACTIONS = ['publish', 'unpublish', 'schedule', 'unschedule', 'discard_changes'] as const
export type PublishingAction = (typeof PUBLISHING_ACTIONS)[number]

export type PublishingArgs = {
  collection: Collection
  slug: string
  action: PublishingAction
  publish_at?: string
  unpublish_at?: string
  mark_updated?: boolean
  /** Set by the plan at the proposal, not by the caller (the input schema has no such field): the day mark_updated writes. */
  updated_on?: string
  base_version: string
  rationale?: string
}

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

const AREA = { blog: 'post', work: 'work' } as const
const ROUTE = { blog: 'admin/posts', work: 'admin/work' } as const

type Schedule = { publish_at: string | null; unpublish_at: string | null }
const iso = (ms: number | null) => (ms === null ? null : toInstantString(ms))

function scheduleOfState(s: ItemState): Schedule {
  const sched = itemSchedule(s.live.frontmatter, s.pending?.frontmatter)
  return { publish_at: iso(sched.publishAt), unpublish_at: iso(sched.unpublishAt) }
}

const row = (r: { frontmatter: Record<string, any>; body: string }) => ({ frontmatter: r.frontmatter, body: r.body })

/** The document that goes live: a draft's own row, or a live item's unpublished changes. */
function goingLive(s: ItemState, markUpdatedDay: string | null) {
  const source = s.draft ? s.live : (s.pending as NonNullable<ItemState['pending']>)
  const fm: Record<string, any> = { ...withoutSchedule(source.frontmatter) }
  delete fm.draft
  if (markUpdatedDay !== null) fm.updated = markUpdatedDay
  return { frontmatter: fm, body: source.body }
}

function previewDoc(s: ItemState, label: string, before: { frontmatter: Record<string, any>; body: string } | null, after: { frontmatter: Record<string, any>; body: string } | null): PreviewDocument {
  return { ref: `${s.c}/${s.slug}`, label, publicUrl: `/${s.c}/${s.slug}`, format: 'mdx', before: itemText(before), after: itemText(after) }
}

function checked(before: { frontmatter: Record<string, any>; body: string } | null, after: { frontmatter: Record<string, any>; body: string } | null): CheckedDocument[] {
  if (!after) return []
  return [{ format: 'mdx', frontmatter: after.frontmatter, body: after.body, before: before ? row(before) : null, rewritten: false }]
}

export function planPublishing(args: PublishingArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  const c = args.collection
  const s = itemState(c, args.slug)
  if (!s) return refuse('NOT_FOUND', 'Nothing exists at that address. Check the collection and slug with search_content.')
  const stale = versionProblem(args.base_version, s.version, `The ${noun(c)}`)
  if (stale) return stale
  const n = noun(c)
  const live = row(s.live)
  const before = itemBefore(c, s.slug)
  const scheduleBefore = scheduleOfState(s)
  const base = {
    target: { kind: c, ref: s.slug },
    baseVersion: s.version,
    rationale: args.rationale ?? null,
    before,
    held: null,
    proposal: true,
    editUrl: itemEditUrl(c, s.slug),
  }
  const canonical = { collection: c, slug: s.slug, action: args.action, base_version: s.version }

  switch (args.action) {
    case 'publish': {
      if (!s.draft && !s.pending) return refuse('NO_VISIBLE_CHANGE', `This ${n} is live and has no unpublished changes: there is nothing to publish.`)
      if (args.mark_updated && (c !== 'blog' || s.draft)) return refuse('INVALID_INPUT', 'mark_updated: only the unpublished changes of a live post can be marked as updated.', { field: 'mark_updated' })
      const updatedOn = args.mark_updated ? (args.updated_on ?? publishDay(ctx.now)) : null
      if (updatedOn !== null && !DAY_RE.test(updatedOn)) return refuse('INVALID_INPUT', 'mark_updated: the stored day is not a calendar day.', { field: 'mark_updated' })
      const after = goingLive(s, updatedOn)
      const shownBefore = s.draft ? null : live
      const scheduleAfter: Schedule = { publish_at: null, unpublish_at: s.draft ? (scheduleBefore.unpublish_at && Date.parse(scheduleBefore.unpublish_at) > ctx.now ? scheduleBefore.unpublish_at : null) : scheduleBefore.unpublish_at }
      return {
        ...base,
        kind: 'item.publish',
        risk: 'live',
        args: { ...canonical, ...(updatedOn !== null ? { mark_updated: true, updated_on: updatedOn } : {}) },
        preview: {
          kind: 'item.publish',
          risk: 'live',
          title: s.draft ? `Publish ${n} ${s.slug}` : `Publish the unpublished changes to ${n} ${s.slug}`,
          documents: [previewDoc(s, `Public version of ${n} ${s.slug}`, shownBefore, after)],
          effects: { publicPaths: itemPublicPaths(c, s.slug), schedule: { before: scheduleBefore, after: scheduleAfter }, deleted: false, import: null, hiddenValuesChanged: null },
        },
        check: { kind: 'documents', documents: checked(shownBefore, after) },
        audit: s.draft
          ? { route: ROUTE[c], method: 'PUT', body: { slug: s.slug, frontmatter: after.frontmatter } }
          : { entry: { action: `${AREA[c]}.publish`, area: AREA[c], target: s.slug, summary: `Published the unpublished changes to ${n} “${s.slug}”` } },
      }
    }
    case 'unpublish': {
      if (s.draft) return refuse('NO_VISIBLE_CHANGE', `This ${n} is not published: there is nothing to unpublish.`)
      return {
        ...base,
        kind: 'item.unpublish',
        risk: 'destructive',
        args: canonical,
        preview: {
          kind: 'item.unpublish',
          risk: 'destructive',
          title: `Unpublish ${n} ${s.slug}`,
          documents: [previewDoc(s, `Public version of ${n} ${s.slug}`, live, null)],
          effects: { publicPaths: itemPublicPaths(c, s.slug), schedule: { before: scheduleBefore, after: { publish_at: null, unpublish_at: null } }, deleted: false, import: null, hiddenValuesChanged: null },
        },
        check: { kind: 'documents', documents: [] },
        audit: { route: ROUTE[c], method: 'PUT', body: { slug: s.slug, frontmatter: { ...withoutSchedule((s.pending ?? s.live).frontmatter), draft: true } } },
      }
    }
    case 'schedule': {
      const publishAt = args.publish_at === undefined ? null : parseInstant(args.publish_at)
      const unpublishAt = args.unpublish_at === undefined ? null : parseInstant(args.unpublish_at)
      if (args.publish_at !== undefined && publishAt === null) return refuse('INVALID_INPUT', 'publish_at: an ISO 8601 instant with a time zone, for example 2026-12-01T09:00:00+08:00.', { field: 'publish_at' })
      if (args.unpublish_at !== undefined && unpublishAt === null) return refuse('INVALID_INPUT', 'unpublish_at: an ISO 8601 instant with a time zone.', { field: 'unpublish_at' })
      if (publishAt === null && unpublishAt === null) return refuse('INVALID_INPUT', 'Send publish_at, unpublish_at or both; to clear a schedule use the action unschedule.')
      const markUpdated = args.mark_updated === true
      const problem = checkSchedule({ publishAt, unpublishAt, markUpdated }, { draft: s.draft, hasPending: !s.draft && !!s.pending }, ctx.now)
      if (problem) return refuse('INVALID_INPUT', problem.error, { reason: problem.code })
      const scheduleAfter: Schedule = { publish_at: iso(publishAt), unpublish_at: iso(unpublishAt) }
      // What changes publicly when the schedule runs: the version that goes live at publish_at, else the item coming down.
      const after = publishAt !== null ? goingLive(s, markUpdated ? publishDay(publishAt) : null) : null
      const shownBefore = s.draft ? null : live
      return {
        ...base,
        kind: 'item.schedule',
        risk: 'live',
        args: { ...canonical, ...(publishAt !== null ? { publish_at: iso(publishAt) } : {}), ...(unpublishAt !== null ? { unpublish_at: iso(unpublishAt) } : {}), ...(markUpdated ? { mark_updated: true } : {}) },
        preview: {
          kind: 'item.schedule',
          risk: 'live',
          title: `Schedule ${n} ${s.slug}`,
          documents: [previewDoc(s, publishAt !== null ? `Public version of ${n} ${s.slug} at the publish time` : `Public version of ${n} ${s.slug} at the unpublish time`, shownBefore, after)],
          effects: { publicPaths: itemPublicPaths(c, s.slug), schedule: { before: scheduleBefore, after: scheduleAfter }, deleted: false, import: null, hiddenValuesChanged: null },
        },
        check: { kind: 'documents', documents: checked(shownBefore, after) },
        audit: { route: ROUTE[c], method: 'POST', body: { action: 'schedule', slug: s.slug, publishAt: iso(publishAt), unpublishAt: iso(unpublishAt) } },
      }
    }
    case 'unschedule': {
      if (scheduleBefore.publish_at === null && scheduleBefore.unpublish_at === null) return refuse('NO_VISIBLE_CHANGE', `This ${n} has no schedule to clear.`)
      // Nothing changes in the text: the card shows what was scheduled, before and after alike.
      const scheduled = scheduleBefore.publish_at !== null ? goingLive(s, null) : live
      return {
        ...base,
        kind: 'item.unschedule',
        risk: 'live',
        args: canonical,
        preview: {
          kind: 'item.unschedule',
          risk: 'live',
          title: `Clear the schedule of ${n} ${s.slug}`,
          documents: [previewDoc(s, `Scheduled version of ${n} ${s.slug}`, scheduled, scheduled)],
          effects: { publicPaths: [], schedule: { before: scheduleBefore, after: { publish_at: null, unpublish_at: null } }, deleted: false, import: null, hiddenValuesChanged: null },
        },
        check: { kind: 'documents', documents: [] },
        audit: { route: ROUTE[c], method: 'POST', body: { action: 'schedule', slug: s.slug, publishAt: null, unpublishAt: null } },
      }
    }
    case 'discard_changes': {
      if (!s.pending) return refuse('NO_VISIBLE_CHANGE', `This ${n} has no unpublished changes to discard.`)
      return {
        ...base,
        kind: 'item.discard-changes',
        risk: 'live',
        args: canonical,
        preview: {
          kind: 'item.discard-changes',
          risk: 'live',
          title: `Discard the unpublished changes to ${n} ${s.slug}`,
          documents: [{ ...previewDoc(s, `Unpublished changes of ${n} ${s.slug}`, row(s.pending), live), publicUrl: `/${c}/${s.slug}` }],
          effects: { publicPaths: [], schedule: scheduleBefore.publish_at !== null ? { before: scheduleBefore, after: { publish_at: null, unpublish_at: scheduleBefore.unpublish_at } } : null, deleted: false, import: null, hiddenValuesChanged: null },
        },
        check: { kind: 'documents', documents: [] },
        audit: { route: ROUTE[c], method: 'POST', body: { action: 'discard-pending', slug: s.slug } },
      }
    }
    default:
      return refuse('INVALID_INPUT', 'action: publish, unpublish, schedule, unschedule or discard_changes.')
  }
}
