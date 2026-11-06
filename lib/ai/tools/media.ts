import * as z from 'zod'
import { readMediaMeta } from '../../media/metaStore'
import { referencedAnywhere, uploadFacts, viewUploads, type MediaPlace } from '../publicMedia'
import { READ_ANNOTATIONS, defineTool, ok, pageOf, refuse, type ToolContext } from '../toolTypes'

/**
 * list_media (design §4.2): the uploads the AI views refer to
 * (lib/ai/publicMedia), with their size and default texts. Without draft
 * access only what public pages show; with it, also what drafts and
 * unpublished changes use, and the uploads nothing refers to (`unused`).
 */

const canDraft = (ctx: ToolContext) => ctx.scopes.has('content:draft')
const fold = (s: string) => s.normalize('NFKC').toLowerCase()

export const listMedia = defineTool({
  name: 'list_media',
  title: 'List images',
  description:
    'List uploaded images the content uses, with size, default alt texts and captions (English and Chinese) and where each is used. ' +
    'filter missing_alt: images with no default alt text in either language. filter unused: images nothing refers to (needs draft access). ' +
    'query matches the file name and texts (up to 200 characters). limit is 1 to 50 (default 20); pass next_cursor back as cursor. ' +
    'Reference an image in content as /uploads/<name>.',
  scope: 'content:read',
  cost: 'expensive',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: true, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    filter: z.enum(['missing_alt', 'unused']).optional().describe('missing_alt or unused (unused needs draft access).'),
    query: z.string().max(200).optional().describe('Words that must all appear in the name or the texts.'),
    limit: z.number().int().min(1).max(50).optional().describe('Rows per page, 1 to 50. Default 20.'),
    cursor: z.string().max(32).optional().describe('next_cursor of the previous page.'),
  }),
  targetOf: () => null,
  read(args, ctx) {
    if (args.filter === 'unused' && !canDraft(ctx)) return refuse('INSUFFICIENT_SCOPE', 'filter unused needs draft access (content:draft).')
    const facts = uploadFacts()
    const texts = readMediaMeta().doc.items
    let names: Map<string, MediaPlace[]>
    if (args.filter === 'unused') {
      const used = referencedAnywhere()
      names = new Map(Array.from(facts.keys()).filter((n) => !used.has(n)).map((n) => [n, []]))
    } else {
      names = viewUploads({ drafts: canDraft(ctx) })
    }
    const words = fold(args.query ?? '').split(/\s+/).filter(Boolean)
    const rows = Array.from(names.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, places]) => {
        const f = facts.get(name)
        const t = texts[name]
        return {
          name,
          url: `/uploads/${encodeURIComponent(name)}`,
          width: f?.width ?? null,
          height: f?.height ?? null,
          bytes: f?.bytes ?? null,
          alt: t?.alt ?? '',
          alt_zh: t?.altZh ?? '',
          caption: t?.caption ?? '',
          caption_zh: t?.captionZh ?? '',
          ...(canDraft(ctx) ? { texts_version: t?.updatedAt ?? 0 } : {}),
          used_by: places.map((p) => ({ doc: p.doc, title: p.title, state: p.state, public_url: p.public_url })),
        }
      })
      .filter((r) => args.filter !== 'missing_alt' || (!r.alt && !r.alt_zh))
      .filter((r) => words.every((w) => fold([r.name, r.alt, r.alt_zh, r.caption, r.caption_zh].join(' ')).includes(w)))
    const page = pageOf(rows, args.cursor, args.limit ?? 20)
    if (!page) return refuse('INVALID_INPUT', 'cursor: pass next_cursor from the previous page, unchanged.')
    return ok(page)
  },
})
