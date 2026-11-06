import { getItem } from '../../contentStore'
import type { Collection } from '../../contentOps/rules'
import { getPendingRevision } from '../../pendingRevisions'
import { COLLECTION_EXTRA_PATHS, CV_DOCUMENT_PATHS } from '../../revalidate'
import { TAG_FIELD, retagList, tagsOf } from '../../tagAdmin'
import { tagSlug } from '../../tagFilter'
import { planTagChange as tagPlan } from '../../tagPlan'
import type { ToolContext, ToolRefusal } from '../toolTypes'
import { itemBefore, itemText, needsDraftAccess, noun, refuse } from './common'
import type { BeforeState, CheckedDocument, PreviewDocument, WritePlan } from './types'

/**
 * Plan of `propose_tag_change` (pure, design §4.2): rename one tag, or merge
 * several into one, on every post (tags) or case study (tech) — the live
 * versions and the unpublished changes alike, as the Tags page does it
 * (lib/tagPlan, the same plan its writer runs). One document per changed
 * row, at most 100. No single undo: each document keeps its own history.
 */

export type TagChangeArgs = { collection: Collection; from: string[]; to: string; rationale?: string }

export const MAX_DOCUMENTS = 100

export function planTagChange(args: TagChangeArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  const c = args.collection
  const request = { collection: c, from: [...args.from], to: args.to.trim() }
  const plan = tagPlan(request)
  if (!plan.ok) return refuse('INVALID_INPUT', `${plan.error}.`)
  if (!plan.items.length) return refuse('NO_VISIBLE_CHANGE', `No ${noun(c)} carries ${request.from.length === 1 ? 'that tag' : 'those tags'}.`)
  const field = TAG_FIELD[c]
  const from = new Set(request.from)
  const documents: PreviewDocument[] = []
  const checked: CheckedDocument[] = []
  const before: BeforeState[] = []
  const paths = new Set<string>([`/${c}`])
  for (const item of plan.items) {
    const live = getItem(c, item.slug)
    if (!live) continue
    const draft = !!live.frontmatter?.draft
    before.push(itemBefore(c, item.slug))
    const liveTags = retagList(tagsOf(live.frontmatter?.[field]), from, request.to)
    if (liveTags.changed) {
      const after = { frontmatter: { ...live.frontmatter, [field]: liveTags.list.length ? liveTags.list : undefined }, body: live.body }
      documents.push({ ref: `${c}/${item.slug}`, label: `${draft ? 'Draft ' : ''}${noun(c)} ${item.slug}`, publicUrl: draft ? null : `/${c}/${item.slug}`, format: 'mdx', before: itemText(live), after: itemText(after) })
      checked.push({ format: 'mdx', frontmatter: JSON.parse(JSON.stringify(after.frontmatter)), body: after.body, before: { frontmatter: live.frontmatter, body: live.body }, rewritten: true })
      if (!draft) paths.add(`/${c}/${item.slug}`)
    }
    const rev = draft ? null : getPendingRevision(c, item.slug)
    if (rev) {
      const pendTags = retagList(tagsOf(rev.frontmatter?.[field]), from, request.to)
      if (pendTags.changed) {
        const after = { frontmatter: { ...rev.frontmatter, [field]: pendTags.list.length ? pendTags.list : undefined }, body: rev.body }
        documents.push({ ref: `${c}/${item.slug}#pending`, label: `Unpublished changes of ${noun(c)} ${item.slug}`, publicUrl: null, format: 'mdx', before: itemText(rev), after: itemText(after) })
        checked.push({ format: 'mdx', frontmatter: JSON.parse(JSON.stringify(after.frontmatter)), body: after.body, before: { frontmatter: rev.frontmatter, body: rev.body }, rewritten: true })
      }
    }
  }
  if (!documents.length) return refuse('NO_VISIBLE_CHANGE', `No ${noun(c)} carries ${request.from.length === 1 ? 'that tag' : 'those tags'}.`)
  if (documents.length > MAX_DOCUMENTS) return refuse('EDIT_TOO_LARGE', `The change would touch more than ${MAX_DOCUMENTS} documents. Ask the owner to do it on the Tags page.`)
  const merge = request.from.length > 1 || plan.mergesInto !== null
  const area = c === 'blog' ? 'post' : 'work'
  const n = plan.items.length
  const nouns = c === 'blog' ? (n === 1 ? 'post' : 'posts') : n === 1 ? 'case study' : 'case studies'
  return {
    kind: 'tag.change',
    risk: 'live',
    proposal: true,
    target: { kind: 'tags', ref: c },
    baseVersion: null,
    args: { collection: c, from: request.from, to: request.to },
    rationale: args.rationale ?? null,
    before: { kind: 'documents', documents: before },
    preview: {
      kind: 'tag.change',
      risk: 'live',
      // Server-composed: the new name is in the documents, where it reads as a change.
      title: `${merge ? 'Merge tags' : 'Rename a tag'} on ${n} ${nouns}`,
      documents,
      effects: { publicPaths: Array.from(new Set([...paths, ...COLLECTION_EXTRA_PATHS[c], ...CV_DOCUMENT_PATHS])), schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    held: null,
    check: { kind: 'documents', documents: checked },
    // Tag slugs only: a tag's spelling is model text.
    audit: { entry: { action: merge ? 'tag.merge' : 'tag.rename', area, target: tagSlug(request.to), summary: `${merge ? 'Merged' : 'Renamed'} ${request.from.join(', ')} → ${tagSlug(request.to)} on ${n} ${nouns}` } },
    editUrl: '/admin/tags',
  }
}
