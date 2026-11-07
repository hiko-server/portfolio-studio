import { documentText } from '../../../components/Admin/shell/textDiff'
import { defaultAltTransform } from '../../media/applyAlt'
import { planDocuments, type PlannedDoc } from '../../media/docPlan'
import { assetExists } from '../../media/library'
import { readMediaMeta } from '../../media/metaStore'
import { readPage } from '../../mdx-admin'
import { isValidUploadName } from '../../security/uploadName'
import { isVariantName } from '../../uploadVariants'
import type { ToolContext, ToolRefusal } from '../toolTypes'
import { itemBefore, needsDraftAccess, refuse } from './common'
import { visibleUpload } from './media'
import type { BeforeState, CheckedDocument, PreviewDocument, WritePlan } from './types'

/**
 * Plan of `propose_apply_alt` (pure, design §4.2): fill in the image's
 * default alt text wherever a post, case study (live version and
 * unpublished changes) or page shows it without one — the media library's
 * "Use the default alt text", computed as a dry run (lib/media/docPlan, the
 * documents its writer would store). The default texts are read now and
 * stored in the arguments: the approval writes exactly them
 * (applyDefaultAlt(name, expected)), and texts changed meanwhile — by the
 * owner or by set_media_text — are a conflict. One document per place, at
 * most 100; no single undo, each document keeps its own history.
 */

export type ApplyAltArgs = { name: string; expected?: { alt: string; altZh: string }; rationale?: string }

const MAX_DOCUMENTS = 100
const NOT_FOUND: ToolRefusal = { ok: false, code: 'NOT_FOUND', message: 'There is no image with that name. Find names with list_media.' }

const NOUN: Record<string, string> = { post: 'Post', work: 'Case study', page: 'Page' }

export async function planApplyAlt(args: ApplyAltArgs, ctx: ToolContext): Promise<WritePlan | ToolRefusal> {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  const name = args.name
  if (!isValidUploadName(name) || isVariantName(name) || !assetExists(name) || !visibleUpload(name)) return NOT_FOUND
  const meta = readMediaMeta().doc.items[name]
  if (!meta?.alt && !meta?.altZh) return refuse('INVALID_INPUT', 'The image has no default alt text yet: set one with set_media_text first.')
  const expected = { alt: meta.alt, altZh: meta.altZh }
  if (args.expected && (args.expected.alt !== expected.alt || args.expected.altZh !== expected.altZh)) {
    return refuse('VERSION_CONFLICT', 'The default alt text of this image changed since this was proposed.')
  }
  const planned = await planDocuments(defaultAltTransform(name, expected))
  const documents: PreviewDocument[] = []
  const checked: CheckedDocument[] = []
  const before: BeforeState[] = []
  const paths = new Set<string>()
  const add = (doc: PlannedDoc, ref: string, label: string, publicUrl: string | null, row: { before: { frontmatter: Record<string, unknown>; body: string }; after: { frontmatter: Record<string, unknown>; body: string } }) => {
    documents.push({ ref, label, publicUrl, format: 'mdx', before: documentText(row.before.frontmatter, row.before.body), after: documentText(row.after.frontmatter, row.after.body) })
    checked.push({ format: 'mdx', frontmatter: row.after.frontmatter, body: row.after.body, before: row.before, rewritten: true })
    doc.paths.forEach((p) => paths.add(p))
  }
  for (const doc of planned) {
    if (doc.kind === 'item') {
      const noun = NOUN[doc.target.kind]
      before.push(itemBefore(doc.collection, doc.slug))
      if (doc.live.count) add(doc, `${doc.collection}/${doc.slug}`, `${doc.draft ? 'Draft ' : ''}${noun} ${doc.slug}`, doc.draft ? null : `/${doc.collection}/${doc.slug}`, doc.live)
      if (doc.pending && doc.pending.count) add(doc, `${doc.collection}/${doc.slug}#pending`, `Unpublished changes of ${noun.toLowerCase()} ${doc.slug}`, null, doc.pending)
    } else if (doc.kind === 'page') {
      const page = readPage(doc.name)
      before.push({ kind: 'page', name: doc.name, page: { frontmatter: page.frontmatter, body: page.body, updatedAt: page.updatedAt } })
      add(doc, `page/${doc.name}`, `Page ${doc.target.title}`, doc.paths[0] ?? null, doc.row)
    }
  }
  if (!documents.length) return refuse('NO_VISIBLE_CHANGE', 'Every place that shows this image already has alt text.')
  if (documents.length > MAX_DOCUMENTS) return refuse('EDIT_TOO_LARGE', `The image is shown in more than ${MAX_DOCUMENTS} places without alt text. Ask the owner to fill them in from the media library.`)
  const places = planned.reduce((n, d) => n + d.target.references, 0)
  return {
    kind: 'media.apply-alt',
    risk: 'live',
    proposal: true,
    target: { kind: 'media', ref: name },
    baseVersion: String(meta.updatedAt),
    args: { name, expected },
    rationale: args.rationale ?? null,
    before: { kind: 'documents', documents: before },
    preview: {
      kind: 'media.apply-alt',
      risk: 'live',
      title: `Fill in the alt text of image ${name} in ${places} ${places === 1 ? 'place' : 'places'}`,
      documents,
      effects: { publicPaths: Array.from(paths), schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    held: null,
    check: { kind: 'documents', documents: checked },
    audit: { entry: { action: 'media.apply-alt', area: 'media', target: name, summary: `Filled in the alt text of image “${name}” in ${places} ${places === 1 ? 'place' : 'places'}` } },
    editUrl: `/admin/media?open=${encodeURIComponent(name)}`,
  }
}
