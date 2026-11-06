import { documentText } from '../../../components/Admin/shell/textDiff'
import { mergeFrontmatter } from '../../frontmatterMerge'
import { isPageName, readPage, versionEtag, type PageName } from '../../mdx-admin'
import { pageAdminPath, pagePublicPath } from '../../pageNames'
import { pageRevalidatePaths } from '../../revalidate'
import { applyEdits, type TextEdit } from '../edits'
import type { ToolContext, ToolRefusal } from '../toolTypes'
import { needsDraftAccess, refuse, versionProblem } from './common'
import { editsRefusal } from './items'
import { canonicalJson, type WritePlan } from './types'

/**
 * Plan of `propose_page_edit` (pure, design §4.2): a change to /now, /uses
 * or a bio. These pages have no unpublished state — a save is public at
 * once — so the change waits for the owner's approval. The body after the
 * edits is resolved now and stored: the approval executes exactly it. An
 * empty body is refused: clearing a page stays the owner's.
 */

export type PageEditArgs = {
  name: PageName
  edits?: TextEdit[]
  body?: string
  frontmatter_patch?: Record<string, unknown>
  remove_frontmatter?: string[]
  base_version: string
  rationale?: string
}

const LABEL: Record<PageName, string> = { now: '/now', uses: '/uses', about: 'the About bio', 'about-zh': 'the Chinese bio' }

const plain = (v: Record<string, unknown>) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>

export function planPageEdit(args: PageEditArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  if (!isPageName(args.name)) return refuse('NOT_FOUND', 'There is no page with that name: now, uses, about or about-zh.')
  const page = readPage(args.name)
  const version = versionEtag(page.updatedAt)
  const stale = versionProblem(args.base_version, version, 'The page')
  if (stale) return stale

  let body = args.body ?? page.body
  if (args.edits) {
    const out = applyEdits(page.body, args.edits)
    if (!out.ok) return editsRefusal(out)
    body = out.body
  }
  if (!body.trim()) return refuse('INVALID_INPUT', 'The page would be empty. Clearing a page is the owner’s to do in its editor.', { field: 'body' })

  const patch = args.frontmatter_patch ? plain(args.frontmatter_patch) : {}
  const removed = args.remove_frontmatter ?? []
  // The same server-side merge as a draft edit (lib/contentOps/drafts): keys not touched stay as stored.
  const edited: Record<string, unknown> = { ...patch }
  for (const k of removed) edited[k] = undefined
  const frontmatter = plain(mergeFrontmatter(page.frontmatter, edited))
  if (typeof frontmatter.title !== 'string' || !frontmatter.title.trim()) return refuse('INVALID_INPUT', 'The page needs a title.', { field: 'frontmatter_patch.title' })
  const before = { frontmatter: page.frontmatter as Record<string, unknown>, body: page.body }
  const beforeText = documentText(before.frontmatter, before.body)
  const afterText = documentText(frontmatter, body)
  if (beforeText === afterText && canonicalJson(frontmatter) === canonicalJson(plain(page.frontmatter))) {
    return refuse('NO_VISIBLE_CHANGE', 'The change leaves the page exactly as it is.')
  }
  const name = args.name
  return {
    kind: 'page.edit',
    risk: 'live',
    proposal: true,
    target: { kind: 'page', ref: name },
    baseVersion: version,
    args: {
      name,
      base_version: version,
      // The body the edits resolved to: what an approval stores.
      body,
      ...(args.frontmatter_patch ? { frontmatter_patch: patch } : {}),
      ...(removed.length ? { remove_frontmatter: [...removed] } : {}),
    },
    rationale: args.rationale ?? null,
    before: { kind: 'page', name, page: page.updatedAt ? { frontmatter: page.frontmatter, body: page.body, updatedAt: page.updatedAt } : null },
    preview: {
      kind: 'page.edit',
      risk: 'live',
      title: `Edit ${LABEL[name]}`,
      documents: [{ ref: `page/${name}`, label: `Page ${LABEL[name]}`, publicUrl: pagePublicPath(name), format: 'mdx', before: beforeText, after: afterText }],
      effects: { publicPaths: pageRevalidatePaths(name), schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    held: null,
    check: { kind: 'item', collection: 'page', touchedKeys: [...Object.keys(patch), ...removed], frontmatter, body, before },
    audit: { route: 'admin/page', method: 'PUT', body: { name, frontmatter, body } },
    editUrl: pageAdminPath(name),
  }
}
