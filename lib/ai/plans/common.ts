import { documentText } from '../../../components/Admin/shell/textDiff'
import { ITEM_RULES, type Collection } from '../../contentOps/rules'
import { getItem } from '../../contentStore'
import { isDraftFrontmatter, isSafeSlug, itemEtag, readOne } from '../../mdx-admin'
import { getPendingRevision } from '../../pendingRevisions'
import { COLLECTION_EXTRA_PATHS, CV_DOCUMENT_PATHS } from '../../revalidate'
import { withoutSchedule } from '../../schedule/fields'
import type { ToolCode, ToolContext, ToolRefusal } from '../toolTypes'
import { canonicalJson, type ItemBeforeState, type PreviewEffects } from './types'

/**
 * Pieces every proposal plan shares (pure: reads only; design §4.2, §5.3).
 */

export const refuse = (code: ToolCode, message: string, data?: Record<string, unknown>): ToolRefusal => ({ ok: false, code, message, ...(data ? { data } : {}) })

export const noun = (c: Collection) => ITEM_RULES[c].noun
export const itemEditUrl = (c: Collection, slug: string) => `/admin/${c}/edit?slug=${encodeURIComponent(slug)}`

/** Pretty canonical JSON (sorted keys, two spaces): the text of a JSON document in a preview, the same bytes every time. */
export const prettyJson = (value: unknown): string => JSON.stringify(JSON.parse(canonicalJson(value ?? null)), null, 2)

export const NO_EFFECTS: PreviewEffects = { publicPaths: [], schedule: null, deleted: false, import: null, hiddenValuesChanged: null }

/**
 * The public pages a post or case-study change regenerates, as a card names
 * them: the item, its index, the pages that list it and the CV. The
 * siblings the regeneration also refreshes are left out on purpose — they
 * change whenever any item is added, and the preview must stay the same
 * for the same change.
 */
export function itemPublicPaths(c: Collection, slug: string): string[] {
  return Array.from(new Set([`/${c}/${slug}`, `/${c}`, ...COLLECTION_EXTRA_PATHS[c], ...CV_DOCUMENT_PATHS]))
}

/** An item's text as a reader sees it: the frontmatter without the server's keys (draft, the schedule). */
export function itemText(row: { frontmatter: Record<string, unknown>; body: string } | null): string {
  if (!row) return ''
  const fm: Record<string, unknown> = { ...withoutSchedule(row.frontmatter as Record<string, any>) }
  delete fm.draft
  return documentText(fm, row.body)
}

export type ItemState = {
  c: Collection
  slug: string
  live: { frontmatter: Record<string, any>; body: string; updatedAt: number }
  pending: { frontmatter: Record<string, any>; body: string; updatedAt: number; baseUpdatedAt: number } | null
  draft: boolean
  version: string
}

/** The stored item as a proposal reads it, or null for an unknown slug. */
export function itemState(c: Collection, slug: string): ItemState | null {
  const live = isSafeSlug(slug) ? readOne(c, slug) : null
  if (!live) return null
  const draft = isDraftFrontmatter(live.frontmatter)
  const pendingRow = draft ? null : getPendingRevision(c, slug)
  const pending = pendingRow ? { frontmatter: pendingRow.frontmatter, body: pendingRow.body, updatedAt: pendingRow.updatedAt, baseUpdatedAt: pendingRow.baseUpdatedAt } : null
  return { c, slug, live: { frontmatter: live.frontmatter, body: live.body, updatedAt: live.updatedAt }, pending, draft, version: itemEtag(live.updatedAt, pending?.updatedAt) }
}

/** The complete before-state of an item: its live and pending rows as stored. */
export function itemBefore(c: Collection, slug: string): ItemBeforeState {
  const live = getItem(c, slug)
  const pending = live ? getPendingRevision(c, slug) : null
  return {
    kind: 'item',
    collection: c,
    slug,
    live: live ? { frontmatter: live.frontmatter, body: live.body, updatedAt: Math.trunc(live.updated_at) } : null,
    pending: pending ? { frontmatter: pending.frontmatter, body: pending.body, updatedAt: pending.updatedAt, baseUpdatedAt: pending.baseUpdatedAt } : null,
  }
}

/** A version as a caller spells it, quotes optional, as the version itself (`"<n>"` or `"<n>.<m>"`), or null. */
export function quotedVersion(raw: string): string | null {
  const inner = raw.trim().replace(/^"(.*)"$/, '$1')
  return /^\d+(?:\.\d+)?$/.test(inner) ? `"${inner}"` : null
}

/** VERSION_CONFLICT unless `base` names `current` exactly. */
export function versionProblem(base: string, current: string, what: string): ToolRefusal | null {
  if (quotedVersion(base) === current) return null
  return refuse('VERSION_CONFLICT', `${what} changed since it was read (or base_version is not the version a read returned): read it again and propose again.`, { current_version: current })
}

/** Proposals show drafts and unpublished changes in their cards, so they need draft access too (every access level that proposes has it). */
export function needsDraftAccess(ctx: ToolContext): ToolRefusal | null {
  return ctx.scopes.has('content:draft') ? null : refuse('INSUFFICIENT_SCOPE', 'Proposals need draft access too (content:draft).')
}

/** Every text value inside `value` (keys excluded). */
export function stringLeaves(value: unknown, into: string[] = [], depth = 0): string[] {
  if (depth > 32) return into
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, into, depth + 1)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, into, depth + 1)
  return into
}

/** Keys that reach an object's prototype: refused anywhere inside a value a proposal stores. */
export const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function hasUnsafeKey(value: unknown, depth = 0): boolean {
  if (depth > 32 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((v) => hasUnsafeKey(v, depth + 1))
  return Object.keys(value).some((k) => UNSAFE_KEYS.has(k) || hasUnsafeKey((value as Record<string, unknown>)[k], depth + 1))
}

/** The leaves a value holds, as a multiset (the canonical JSON of each). */
function leafCounts(value: unknown, into = new Map<string, number>(), depth = 0): Map<string, number> {
  if (depth > 64) return into
  if (value === null || typeof value !== 'object') {
    if (value !== undefined) {
      const k = JSON.stringify(value)
      into.set(k, (into.get(k) ?? 0) + 1)
    }
    return into
  }
  for (const v of Array.isArray(value) ? value : Object.values(value)) leafCounts(v, into, depth + 1)
  return into
}

function minus(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [k, n] of a) {
    const left = n - (b.get(k) ?? 0)
    if (left > 0) out.set(k, left)
  }
  return out
}

const total = (m: Map<string, number>) => Array.from(m.values()).reduce((s, n) => s + n, 0)

/**
 * How many values that the public view does not show change between two
 * stored documents (a restore replaces the whole document, hidden parts
 * included: §4.4's one exception, stated on its card). A value counts as
 * hidden when the stored document holds it and its public view does not;
 * the count is how many such values are added, removed or replaced.
 */
export function hiddenValuesChanged(before: { full: unknown; view: unknown }, after: { full: unknown; view: unknown }): number {
  const hiddenBefore = minus(leafCounts(before.full), leafCounts(before.view))
  const hiddenAfter = minus(leafCounts(after.full), leafCounts(after.view))
  return Math.max(total(minus(hiddenBefore, hiddenAfter)), total(minus(hiddenAfter, hiddenBefore)))
}
