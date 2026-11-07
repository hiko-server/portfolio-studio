import { getItem, listItems } from './contentStore'
import { getPendingRevision, putPendingRevision, rebasedPendingBase } from './pendingRevisions'
import { COLLECTION_EXTRA_PATHS, CV_DOCUMENT_PATHS, collectionPaths } from './revalidate'
import { TAG_FIELD, retagList, tagsOf } from './tagAdmin'
import { planTagChange, type TagChangeFailure, type TagChangeItem, type TagChangePlan, type TagChangeRequest } from './tagPlan'
import { log } from './log'

/**
 * Tag rename / merge across posts or case studies (H16) — the store side of
 * lib/tagAdmin. Every changed item is written through lib/mdx-admin
 * writeOne (a history snapshot first, the R2 mirror, the same as a save
 * from the editor); an item's unpublished changes (H4) get the same tags, so
 * publishing them later never brings an old tag back. Server-only.
 */

export { planTagChange, readTagInventory } from './tagPlan'
export type { TagChangeFailure, TagChangeItem, TagChangePlan, TagChangeRequest } from './tagPlan'

export type TagChangeOutcome = TagChangePlan & { paths: string[]; warnings: string[] }

/** Rename / merge: write every changed item (snapshot first) and its unpublished changes. */
export async function applyTagChange(req: TagChangeRequest): Promise<TagChangeOutcome | TagChangeFailure> {
  const plan = planTagChange(req)
  if (!plan.ok) return plan
  const { writeOne } = await import('./mdx-admin')
  const field = TAG_FIELD[req.collection]
  const from = new Set(req.from)
  const warnings: string[] = []
  const done: TagChangeItem[] = []
  for (const change of plan.items) {
    try {
      const item = getItem(req.collection, change.slug)
      if (!item) continue
      const before = Math.trunc(item.updated_at)
      const live = retagList(tagsOf(item.frontmatter?.[field]), from, req.to)
      if (live.changed) {
        const result = await writeOne(req.collection, change.slug, { ...item.frontmatter, [field]: live.list.length ? live.list : undefined }, item.body)
        if (!result.ok) {
          warnings.push(`${change.title}: ${result.error}`)
          continue
        }
        if ('r2Warning' in result && result.r2Warning) warnings.push(result.r2Warning)
      }
      const rev = getPendingRevision(req.collection, change.slug)
      if (rev) {
        const pend = retagList(tagsOf(rev.frontmatter?.[field]), from, req.to)
        const base = rebasedPendingBase(rev.baseUpdatedAt, before, Math.trunc(getItem(req.collection, change.slug)?.updated_at ?? 0))
        if (pend.changed || base !== rev.baseUpdatedAt) {
          const frontmatter = pend.changed ? { ...rev.frontmatter, [field]: pend.list.length ? pend.list : undefined } : rev.frontmatter
          putPendingRevision(req.collection, change.slug, frontmatter, rev.body, base)
        }
      }
      done.push(change)
    } catch (err) {
      log.error('tag change failed on an item', { err, collection: req.collection, slug: change.slug })
      warnings.push(`${change.title}: not updated`)
    }
  }
  // Tags feed the related-reading links of every post and case study, the
  // /blog and /work filters, the home page and the CV's skill evidence.
  const paths = new Set<string>([
    ...collectionPaths('blog', undefined, listItems('blog').map((i) => i.slug)),
    ...collectionPaths('work', undefined, listItems('work').map((i) => i.slug)),
    ...COLLECTION_EXTRA_PATHS.blog,
    ...COLLECTION_EXTRA_PATHS.work,
    ...CV_DOCUMENT_PATHS,
  ])
  return { ok: true, items: done, mergesInto: plan.mergesInto, paths: done.length ? Array.from(paths) : [], warnings }
}
