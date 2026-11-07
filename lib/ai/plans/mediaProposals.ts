import { documentText } from '../../../components/Admin/shell/textDiff'
import type { Collection } from '../../contentOps/rules'
import { assetExists, isTrashed } from '../../media/library'
import { readMediaMeta } from '../../media/metaStore'
import { checkRemoteImageUrl, RemoteImageError } from '../../remoteImage'
import { isValidUploadName } from '../../security/uploadName'
import { isVariantName } from '../../uploadVariants'
import { withoutSchedule } from '../../schedule/fields'
import { referencedAnywhere, uploadFacts } from '../publicMedia'
import type { ToolContext, ToolRefusal } from '../toolTypes'
import { itemBefore, itemEditUrl, itemPublicPaths, itemState, needsDraftAccess, noun, prettyJson, refuse, versionProblem } from './common'
import { visibleUpload } from './media'
import type { PreviewDocument, WritePlan } from './types'

/**
 * Plans of `propose_media_import` and `propose_delete` (pure, design §4.2).
 *
 * An import is checked as an address only (lib/remoteImage
 * checkRemoteImageUrl: https, a host name, no credentials): nothing is
 * fetched until the owner approves, so the card names the full address and
 * its host, and says the file itself is not seen until it arrives.
 *
 * A delete removes a post or case study (its history keeps it, and its
 * review links end) or moves an unused upload to the 30-day trash. An
 * upload any stored document still refers to answers BLOCKED; one the
 * caller cannot see answers like a name that does not exist.
 */

export type MediaImportArgs = { url: string; rationale?: string }

export function planMediaImport(args: MediaImportArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  let u: URL
  try {
    u = checkRemoteImageUrl(args.url)
  } catch (err) {
    return refuse('INVALID_INPUT', `url: ${err instanceof RemoteImageError ? err.message : 'not an address that can be imported'}.`, { field: 'url' })
  }
  const url = u.toString()
  const host = u.hostname
  return {
    kind: 'media.import',
    risk: 'live',
    proposal: true,
    target: { kind: 'media', ref: host },
    baseVersion: null,
    args: { url },
    rationale: args.rationale ?? null,
    before: { kind: 'documents', documents: [] },
    preview: {
      kind: 'media.import',
      risk: 'live',
      title: `Import an image from ${host}`,
      documents: [],
      effects: { publicPaths: [], schedule: null, deleted: false, import: { url, host }, hiddenValuesChanged: null },
    },
    held: null,
    check: { kind: 'documents', documents: [], extraLinks: [url] },
    audit: { route: 'admin/import-image', method: 'POST', body: { url } },
    editUrl: '/admin/media',
  }
}

export const DELETE_TARGETS = ['post', 'case_study', 'image'] as const
export type DeleteArgs = { target: (typeof DELETE_TARGETS)[number]; ref: string; base_version?: string; rationale?: string }

const NO_IMAGE: ToolRefusal = { ok: false, code: 'NOT_FOUND', message: 'There is no image with that name. Find names with list_media.' }

/** An item's text with its published state (a delete removes it whatever it is). */
const fullText = (row: { frontmatter: Record<string, unknown>; body: string }) => documentText(withoutSchedule(row.frontmatter as Record<string, any>), row.body)

export function planDelete(args: DeleteArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  if (args.target === 'image') {
    const name = args.ref
    if (!isValidUploadName(name) || isVariantName(name) || !assetExists(name) || isTrashed(name) || !visibleUpload(name)) return NO_IMAGE
    if (referencedAnywhere().has(name)) return refuse('BLOCKED', 'This image is still used. Remove it from every place first (list_media shows where it is used).')
    const facts = uploadFacts().get(name)
    const meta = readMediaMeta().doc.items[name]
    const shown = {
      name,
      url: `/uploads/${name}`,
      width: facts?.width ?? null,
      height: facts?.height ?? null,
      bytes: facts?.bytes ?? null,
      alt: meta?.alt ?? '',
      alt_zh: meta?.altZh ?? '',
      caption: meta?.caption ?? '',
      caption_zh: meta?.captionZh ?? '',
    }
    return {
      kind: 'media.trash',
      risk: 'destructive',
      proposal: true,
      target: { kind: 'media', ref: name },
      baseVersion: null,
      args: { target: 'image', ref: name },
      rationale: args.rationale ?? null,
      before: { kind: 'upload', name, exists: true },
      preview: {
        kind: 'media.trash',
        risk: 'destructive',
        title: `Move image ${name} to the trash`,
        documents: [{ ref: `media/${name}`, label: `Image ${name}`, publicUrl: `/uploads/${name}`, format: 'json', before: prettyJson(shown), after: '' }],
        effects: { publicPaths: [], schedule: null, deleted: true, import: null, hiddenValuesChanged: null },
      },
      held: null,
      check: { kind: 'documents', documents: [] },
      audit: { entry: { action: 'media.trash', area: 'media', target: name, summary: `Moved image “${name}” to the trash` } },
      editUrl: `/admin/media?open=${encodeURIComponent(name)}`,
    }
  }

  const c: Collection = args.target === 'post' ? 'blog' : 'work'
  if (args.base_version === undefined) return refuse('INVALID_INPUT', 'base_version: required to delete a post or case study (the version get_content returned).', { field: 'base_version' })
  const s = itemState(c, args.ref)
  if (!s) return refuse('NOT_FOUND', 'Nothing exists at that address. Check the collection and slug with search_content.')
  const stale = versionProblem(args.base_version, s.version, `The ${noun(c)}`)
  if (stale) return stale
  const documents: PreviewDocument[] = [{ ref: `${c}/${s.slug}`, label: `${s.draft ? 'Draft ' : ''}${noun(c)} ${s.slug}`, publicUrl: `/${c}/${s.slug}`, format: 'mdx', before: fullText(s.live), after: '' }]
  if (s.pending) documents.push({ ref: `${c}/${s.slug}#pending`, label: `Unpublished changes of ${noun(c)} ${s.slug}`, publicUrl: null, format: 'mdx', before: fullText(s.pending), after: '' })
  return {
    kind: 'item.delete',
    risk: 'destructive',
    proposal: true,
    target: { kind: c, ref: s.slug },
    baseVersion: s.version,
    args: { target: args.target, ref: s.slug, base_version: s.version },
    rationale: args.rationale ?? null,
    before: itemBefore(c, s.slug),
    preview: {
      kind: 'item.delete',
      risk: 'destructive',
      title: `Delete ${noun(c)} ${s.slug}`,
      documents,
      effects: { publicPaths: s.draft ? [] : itemPublicPaths(c, s.slug), schedule: null, deleted: true, import: null, hiddenValuesChanged: null },
    },
    held: null,
    check: { kind: 'documents', documents: [] },
    audit: { route: c === 'blog' ? 'admin/posts' : 'admin/work', method: 'DELETE', query: { slug: s.slug } },
    editUrl: itemEditUrl(c, s.slug),
  }
}
