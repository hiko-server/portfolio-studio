import { listItems } from './contentStore'
import { listPendingRevisions } from './pendingRevisions'
import { TAG_FIELD, retagList, tagInventory, tagNameProblem, tagsOf, type TagCollection, type TagEntry } from './tagAdmin'
import { tagSlug } from './tagFilter'

/**
 * The read side of tag rename / merge (H16): the inventory and the plan of
 * a change — which items change, and how — without writing anything.
 * lib/tagAdminServer writes the plan (and re-exports this); an AI tag
 * proposal (lib/ai/plans) shows it to the owner first. Server-only (reads
 * the content store); no writer is imported here.
 */

export type TagChangeRequest = {
  collection: TagCollection
  /** Slugs of the tags to rename (one) or merge (several). */
  from: string[]
  /** The new name. */
  to: string
}

export type TagChangeItem = { slug: string; title: string; before: string[]; after: string[]; pendingOnly: boolean }

export type TagChangePlan = { ok: true; items: TagChangeItem[]; mergesInto: string | null }
export type TagChangeFailure = { ok: false; status: 400; error: string }

const titleOf = (fm: Record<string, unknown> | undefined, slug: string) =>
  typeof fm?.title === 'string' && fm.title.trim() ? fm.title.trim() : slug

/** The tag inventory of a collection: live items plus their unpublished changes. */
export function readTagInventory(collection: TagCollection): TagEntry[] {
  const field = TAG_FIELD[collection]
  const pending = new Map(listPendingRevisions(collection).map((p) => [p.slug, p]))
  return tagInventory(
    listItems(collection).map((item) => ({
      slug: item.slug,
      title: titleOf(item.frontmatter, item.slug),
      tags: tagsOf(item.frontmatter?.[field]),
      draft: !!item.frontmatter?.draft,
      pendingTags: pending.has(item.slug) ? tagsOf(pending.get(item.slug)?.frontmatter?.[field]) : null,
    })),
  )
}

function validate(req: TagChangeRequest): TagChangeFailure | null {
  if (req.collection !== 'blog' && req.collection !== 'work') return { ok: false, status: 400, error: 'collection must be "blog" or "work"' }
  if (!Array.isArray(req.from) || !req.from.length || req.from.length > 50 || req.from.some((s) => typeof s !== 'string' || !s || s !== tagSlug(s))) {
    return { ok: false, status: 400, error: 'from must list the slugs of the tags to change' }
  }
  const problem = tagNameProblem(typeof req.to === 'string' ? req.to : '')
  if (problem) return { ok: false, status: 400, error: problem }
  return null
}

/** Which items change, and how (nothing is written). */
export function planTagChange(req: TagChangeRequest): TagChangePlan | TagChangeFailure {
  const invalid = validate(req)
  if (invalid) return invalid
  const field = TAG_FIELD[req.collection]
  const from = new Set(req.from)
  const target = tagSlug(req.to)
  const pending = new Map(listPendingRevisions(req.collection).map((p) => [p.slug, p]))
  const items: TagChangeItem[] = []
  let existsElsewhere = false
  for (const item of listItems(req.collection)) {
    const live = tagsOf(item.frontmatter?.[field])
    const rev = pending.get(item.slug)
    const pend = rev ? tagsOf(rev.frontmatter?.[field]) : null
    if (!from.has(target) && [...live, ...(pend || [])].some((t) => tagSlug(t) === target)) existsElsewhere = true
    const a = retagList(live, from, req.to)
    const b = pend ? retagList(pend, from, req.to) : null
    if (!a.changed && !b?.changed) continue
    items.push({
      slug: item.slug,
      title: titleOf(item.frontmatter, item.slug),
      before: a.changed ? live : pend || live,
      after: a.changed ? a.list : b?.list || live,
      pendingOnly: !a.changed,
    })
  }
  items.sort((a, b) => a.title.localeCompare(b.title, 'en') || a.slug.localeCompare(b.slug, 'en'))
  // Renaming into a tag that already exists (and is not one of those renamed) merges into it.
  return { ok: true, items, mergesInto: existsElsewhere ? target : null }
}
