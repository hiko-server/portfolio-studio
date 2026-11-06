import { stableStringify } from '../contentStore'
import { mergeFrontmatter } from '../frontmatterMerge'
import { hasItemSnapshots, isDraftFrontmatter, isSafeSlug, itemEtag, readOne, writeOne, type AdminItem } from '../mdx-admin'
import { getPendingRevision, putPendingRevision, type PendingRevision } from '../pendingRevisions'
import { redirectTarget } from '../redirects'
import { linkSlugsOf, listReviewLinks } from '../review/store'
import { SCHEDULE_KEYS, carryScheduleOnSave, withoutSchedule } from '../schedule/fields'
import { scheduleOf } from '../schedule/store'
import { ITEM_RULES, type Collection } from './rules'

/**
 * Draft-safe writes to posts and case studies: writes that nobody but the
 * owner can see — a new draft, an edit of a draft, or an edit of a live
 * item stored as its pending revision (H4) while the public page keeps the
 * published version. SERVER-ONLY.
 *
 * What makes them safe, enforced here and not left to the caller:
 *
 *   - the published state is server-owned: a new item is a draft, a draft
 *     stays one, a live item's edit is a pending revision; `draft` and the
 *     schedule keys (H5) are refused as edits, and the stored schedule is
 *     carried (lib/schedule/fields carryScheduleOnSave);
 *   - a new draft never takes over an address with a public or shared
 *     meaning (SLUG_RESERVED): an old slug that still redirects (308) to
 *     another item, an address with active review links, a deleted item's
 *     history. So no redirect is forgotten and no review link turned off;
 *   - an item that would reach someone without the owner's approval is
 *     held (heldReason): a scheduled draft or scheduled changes go live
 *     exactly as stored, and a review link shows a draft or pending changes
 *     to whoever holds it. Edits to such an item are refused unless the
 *     caller says the owner approved this one (`allowHeld`);
 *   - every edit names the version it was made from (mandatory, no "last
 *     write wins").
 *
 * Nothing here regenerates a public page, imports a video poster or writes
 * a live item: no path to the public site. The body is stored as given —
 * the caller checks it first (the AI write path compiles it in a limited
 * worker, lib/ai/validate), because compiling here on the main thread is
 * exactly what that check avoids.
 */

export type { Collection }

export type HeldReason =
  /** A scheduled draft, or a live item's scheduled changes: they go live at `publishAt` exactly as stored. */
  | { code: 'ITEM_SCHEDULED'; publishAt: number }
  /** Active review links show the draft or the pending changes to whoever holds them. */
  | { code: 'ITEM_IN_REVIEW'; activeLinks: number }

export type DraftProblem =
  | { ok: false; code: 'INVALID_INPUT'; error: string }
  | { ok: false; code: 'NOT_FOUND'; error: string }
  | { ok: false; code: 'SLUG_EXISTS'; error: string }
  | { ok: false; code: 'SLUG_RESERVED'; error: string; reason: 'redirect' | 'review_link' | 'deleted' }
  | { ok: false; code: 'VERSION_CONFLICT'; error: string; version: string }
  | ({ ok: false; error: string } & HeldReason)
  | { ok: false; code: 'STORE_ERROR'; error: string }

export type DraftWriteResult =
  | {
      ok: true
      /** Where the write went: the draft itself, or the live item's pending revision. */
      target: 'draft' | 'pending'
      /** The item's version after the write (lib/mdx-admin itemEtag). */
      version: string
      /** False when the edit left the item exactly as it was (nothing written). */
      changed: boolean
      r2Warning?: string
    }
  | DraftProblem

/** Keys an edit may never set or remove: the published state and the schedule are the server's. */
export const SERVER_OWNED_KEYS: readonly string[] = ['draft', ...SCHEDULE_KEYS]

/** Keys no frontmatter may carry: they would reach an object's prototype when merged. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

type Frontmatter = Record<string, unknown>

const isRecord = (v: unknown): v is Frontmatter => !!v && typeof v === 'object' && !Array.isArray(v)
const invalid = (error: string): DraftProblem => ({ ok: false, code: 'INVALID_INPUT', error })
const notFound = (c: Collection): DraftProblem => ({ ok: false, code: 'NOT_FOUND', error: `No such ${ITEM_RULES[c].noun}` })
const unquoted = (version: string) => version.trim().replace(/^"(.*)"$/, '$1')

/** The frontmatter fields every stored item needs (the admin save's rule). */
function missingField(c: Collection, fm: Frontmatter): DraftProblem | null {
  if (!fm.title) return invalid('frontmatter.title is required')
  if (ITEM_RULES[c].requireDate && !fm.date) return invalid('frontmatter.date is required')
  return null
}

/**
 * Why an edit of this item would reach someone without the owner's
 * approval, or null: it is scheduled to publish (its draft, or a live
 * item's pending changes — lib/schedule/store scheduleOf covers both rows),
 * or active review links show it (at its slug or an old slug that leads to
 * it). Reads auth.db for the links: when that fails, this throws and the
 * caller writes nothing.
 */
export function heldReason(c: Collection, slug: string, now = Date.now()): HeldReason | null {
  const { publishAt } = scheduleOf(c, slug)
  if (publishAt !== null) return { code: 'ITEM_SCHEDULED', publishAt }
  const activeLinks = listReviewLinks({ collection: c, slugs: linkSlugsOf(c, slug), now }).length
  return activeLinks > 0 ? { code: 'ITEM_IN_REVIEW', activeLinks } : null
}

function heldProblem(c: Collection, held: HeldReason): DraftProblem {
  const noun = ITEM_RULES[c].noun
  return held.code === 'ITEM_SCHEDULED'
    ? { ok: false, ...held, error: `This ${noun} is scheduled to go live: changing it needs the owner's approval, or unschedule it first` }
    : { ok: false, ...held, error: `Active review links show this ${noun}: changing it needs the owner's approval` }
}

/** Why `slug` must not be taken by a new draft, or null. */
function reservedBy(c: Collection, slug: string, now: number): DraftProblem | null {
  if (redirectTarget(c, slug) !== null) {
    return { ok: false, code: 'SLUG_RESERVED', reason: 'redirect', error: 'This address still redirects to another item; pick another slug' }
  }
  if (listReviewLinks({ collection: c, slugs: linkSlugsOf(c, slug), now }).length > 0) {
    return { ok: false, code: 'SLUG_RESERVED', reason: 'review_link', error: 'Review links are active at this address; pick another slug' }
  }
  // An item deleted from this address can be restored from its history ("Recently deleted").
  if (hasItemSnapshots(c, slug)) {
    return { ok: false, code: 'SLUG_RESERVED', reason: 'deleted', error: 'A deleted item can still be restored at this address; pick another slug' }
  }
  return null
}

export type PreparedCreate = { ok: true; frontmatter: Frontmatter; body: string }

/**
 * The checks of a new draft at `slug` and the row it would store, without
 * writing (`draft: true` forced; no schedule). Refused while the slug is
 * taken (SLUG_EXISTS) or reserved (SLUG_RESERVED, above).
 */
export function prepareDraftCreate(c: Collection, input: { slug: string; frontmatter: Frontmatter; body: string }, opts: { now?: number } = {}): PreparedCreate | DraftProblem {
  const { slug, frontmatter, body } = input
  if (!isSafeSlug(slug)) return invalid('slug must use a-z, 0-9, - and _ and start with a letter or digit')
  if (!isRecord(frontmatter)) return invalid('frontmatter must be an object')
  if (typeof body !== 'string') return invalid('body must be text')
  const unsafe = Object.keys(frontmatter).find((k) => UNSAFE_KEYS.has(k))
  if (unsafe) return invalid(`frontmatter cannot have a key named ${unsafe}`)
  const fm: Frontmatter = { ...withoutSchedule(frontmatter), draft: true }
  const missing = missingField(c, fm)
  if (missing) return missing
  if (readOne(c, slug)) return { ok: false, code: 'SLUG_EXISTS', error: `A ${ITEM_RULES[c].noun} with this slug already exists` }
  const reserved = reservedBy(c, slug, opts.now ?? Date.now())
  if (reserved) return reserved
  return { ok: true, frontmatter: fm, body }
}

/**
 * Create a new draft at `slug` (`draft: true` forced; no schedule). Refused
 * while the slug is taken (SLUG_EXISTS) or reserved (SLUG_RESERVED, above).
 */
export async function createDraftItem(
  c: Collection,
  input: { slug: string; frontmatter: Frontmatter; body: string },
  opts: { now?: number } = {},
): Promise<DraftWriteResult> {
  // Checks and write run without an await in between (single Node process).
  const prepared = prepareDraftCreate(c, input, opts)
  if (!prepared.ok) return prepared
  const { slug } = input
  const out = await writeOne(c, slug, prepared.frontmatter, prepared.body)
  if (!out.ok) return { ok: false, code: 'STORE_ERROR', error: out.error }
  return {
    ok: true,
    target: 'draft',
    version: itemEtag(readOne(c, slug)?.updatedAt ?? 0, getPendingRevision(c, slug)?.updatedAt),
    changed: true,
    ...('r2Warning' in out ? { r2Warning: out.r2Warning } : {}),
  }
}

export type DraftEdit = {
  slug: string
  /** The item's version the edit was made from (itemEtag, with or without its quotes). Required. */
  baseVersion: string
  /** The new body; absent keeps the stored one. */
  body?: string
  /** Frontmatter keys to set, merged into the stored frontmatter (lib/frontmatterMerge); others stay as stored. */
  frontmatterPatch?: Frontmatter
  /** Frontmatter keys to remove. */
  removeFrontmatter?: readonly string[]
}

/** An edit checked against the item as stored, and the row it would write. */
export type PreparedEdit = {
  ok: true
  /** Where the write goes: the draft itself, or the live item's pending revision. */
  target: 'draft' | 'pending'
  /** The item's version now (lib/mdx-admin itemEtag). */
  version: string
  /** The stored item and its pending row (whatever the item's state): the complete state before the edit. */
  live: AdminItem
  pendingRow: PendingRevision | null
  /** What the editor shows now: the live item's pending revision when there is one, else the stored item. */
  shown: { frontmatter: Frontmatter; body: string }
  /** The frontmatter and body the write would store (schedule carried, published state kept). */
  frontmatter: Frontmatter
  body: string
  /** False when the edit would leave the item exactly as it is. */
  changed: boolean
}

/**
 * Check an edit against the item as stored and compute the row it would
 * write, without writing: the version must match, held items are refused
 * unless `allowHeld`, and the published state and schedule are the
 * server's. saveDraftEdit writes exactly this.
 */
export function prepareDraftEdit(c: Collection, edit: DraftEdit, opts: { allowHeld?: boolean; now?: number } = {}): PreparedEdit | DraftProblem {
  const { slug, baseVersion, body, frontmatterPatch, removeFrontmatter } = edit
  if (typeof baseVersion !== 'string' || !baseVersion.trim()) return invalid('base_version is required: read the item first')
  if (body !== undefined && typeof body !== 'string') return invalid('body must be text')
  if (frontmatterPatch !== undefined && !isRecord(frontmatterPatch)) return invalid('frontmatter_patch must be an object')
  if (removeFrontmatter !== undefined && !(Array.isArray(removeFrontmatter) && removeFrontmatter.every((k) => typeof k === 'string'))) {
    return invalid('remove_frontmatter must be a list of keys')
  }
  const named = [...Object.keys(frontmatterPatch ?? {}), ...(removeFrontmatter ?? [])]
  const unsafe = named.find((k) => UNSAFE_KEYS.has(k))
  if (unsafe) return invalid(`frontmatter cannot have a key named ${unsafe}`)
  const owned = named.find((k) => SERVER_OWNED_KEYS.includes(k))
  if (owned) return invalid(`${owned} cannot be edited: publishing and scheduling are separate actions`)
  if (body === undefined && named.length === 0) return invalid('Nothing to change: send a body or frontmatter changes')
  if (!isSafeSlug(slug)) return notFound(c)

  const live = readOne(c, slug)
  if (!live) return notFound(c)
  const draft = isDraftFrontmatter(live.frontmatter)
  // The version covers a pending row whatever the item's state (as every reader's itemEtag does);
  // only a live item's pending revision is what the editor shows (a draft never holds one).
  const pendingRow = getPendingRevision(c, slug)
  const pending = draft ? null : pendingRow
  const current = itemEtag(live.updatedAt, pendingRow?.updatedAt)
  if (unquoted(baseVersion) !== unquoted(current)) {
    return { ok: false, code: 'VERSION_CONFLICT', error: 'The item changed since that version was read: read it again', version: current }
  }
  if (!opts.allowHeld) {
    const held = heldReason(c, slug, opts.now)
    if (held) return heldProblem(c, held)
  }

  const view = pending ?? live
  const edited: Frontmatter = { ...(frontmatterPatch ?? {}) }
  for (const k of removeFrontmatter ?? []) edited[k] = undefined
  const merged = mergeFrontmatter(withoutSchedule(view.frontmatter), edited)
  const text = body ?? view.body
  const now = opts.now ?? Date.now()
  const shown = { frontmatter: view.frontmatter, body: view.body }

  if (draft) {
    const fm = carryScheduleOnSave({ target: 'live', live: live.frontmatter, pending: null, incoming: { ...merged, draft: true }, now })
    const missing = missingField(c, fm)
    if (missing) return missing
    const changed = !(text === live.body && stableStringify(fm) === stableStringify(live.frontmatter))
    return { ok: true, target: 'draft', version: current, live, pendingRow, shown, frontmatter: fm, body: text, changed }
  }

  // A live item: the edit is its pending revision; the published state stays the live row's.
  const fm = carryScheduleOnSave({ target: 'pending', live: live.frontmatter, pending: pending?.frontmatter ?? null, incoming: { ...merged, draft: live.frontmatter.draft }, now })
  if (fm.draft === undefined) delete fm.draft
  const missing = missingField(c, fm)
  if (missing) return missing
  const unchanged = pending
    ? text === pending.body && stableStringify(fm) === stableStringify(pending.frontmatter)
    : text === live.body && stableStringify(fm) === stableStringify(withoutSchedule(live.frontmatter))
  return { ok: true, target: 'pending', version: current, live, pendingRow, shown, frontmatter: fm, body: text, changed: !unchanged }
}

/**
 * Edit an existing item without publishing anything: a draft stays a draft
 * (its own row, `draft: true` forced, its schedule kept), and a live item's
 * edit goes to its pending revision (whose scheduled time, if any, stays).
 * The edit applies to what the editor shows — the pending revision when
 * there is one, else the stored item — and `target` in the result says
 * where it went. Held items are refused (ITEM_SCHEDULED, ITEM_IN_REVIEW)
 * unless `allowHeld`: only for an edit the owner approved.
 */
export async function saveDraftEdit(c: Collection, edit: DraftEdit, opts: { allowHeld?: boolean; now?: number } = {}): Promise<DraftWriteResult> {
  // Checks and write run without an await in between (single Node process).
  const prepared = prepareDraftEdit(c, edit, opts)
  if (!prepared.ok) return prepared
  const { slug } = edit
  const { live, pendingRow, version } = prepared
  if (!prepared.changed) return { ok: true, target: prepared.target, version, changed: false }
  if (prepared.target === 'draft') {
    const out = await writeOne(c, slug, prepared.frontmatter, prepared.body)
    if (!out.ok) return { ok: false, code: 'STORE_ERROR', error: out.error }
    return {
      ok: true,
      target: 'draft',
      version: itemEtag(readOne(c, slug)?.updatedAt ?? 0, pendingRow?.updatedAt),
      changed: true,
      ...('r2Warning' in out ? { r2Warning: out.r2Warning } : {}),
    }
  }
  const rev = putPendingRevision(c, slug, prepared.frontmatter, prepared.body, live.updatedAt)
  return { ok: true, target: 'pending', version: itemEtag(live.updatedAt, rev.updatedAt), changed: true }
}
