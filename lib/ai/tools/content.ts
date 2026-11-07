import * as z from 'zod'
import { getItem, listItems, type ItemRecord } from '../../contentStore'
import { PAGE_NAMES, isPageName, isSafeSlug, itemEtag, readPage, versionEtag, type PageName } from '../../mdx-admin'
import { pageAdminPath, pagePublicPath } from '../../pageNames'
import { getPendingRevision } from '../../pendingRevisions'
import { withoutSchedule } from '../../schedule/fields'
import { tagsOf, TAG_FIELD } from '../../tagAdmin'
import { tagSlug } from '../../tagFilter'
import { detectContentLang } from '../../toc'
import { READ_ANNOTATIONS, RESULT_MAX_BYTES, byteLength, defineTool, ok, pageOf, refuse, textWindow, type ToolContext } from '../toolTypes'
import { heldFlags, isDraftRow, publishedItems, type AiCollection } from '../views'
import { editorOfItem, editorOfPage } from '../plans/editor'

/**
 * search_content and get_content (design §4.2): posts, case studies and the
 * single pages (/now, /uses, the bios).
 *
 * Without content:draft a caller sees what visitors see: published items
 * only. A draft answers exactly what an unknown slug answers, and no row
 * carries a version, a schedule or unpublished changes. With content:draft a
 * row also carries what a writer needs before it edits: the version, the
 * unpublished changes, when the item is scheduled to go live and whether
 * review links show it (held items, §4.6).
 */

const COLLECTIONS = ['blog', 'work', 'page'] as const

const canDraft = (ctx: ToolContext) => ctx.scopes.has('content:draft')
const editUrl = (c: AiCollection, slug: string) => `/admin/${c}/edit?slug=${encodeURIComponent(slug)}`
const publicUrl = (c: AiCollection, slug: string) => `/${c}/${slug}`
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** The answer to an unknown address, and to a draft at content:read: the same bytes. */
const NOT_PUBLISHED = 'Nothing is published at that address. Check the collection and slug with search_content.'

/** The frontmatter a reader is shown: no schedule keys and no draft flag (both are the server's). */
function shownFrontmatter(fm: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...withoutSchedule((fm ?? {}) as Record<string, any>) }
  delete out.draft
  return out
}

/** The item's version as the write path checks it (lib/contentOps/drafts): the stored row's and its pending row's times. */
const versionOf = (c: AiCollection, item: ItemRecord) => itemEtag(Math.trunc(item.updated_at), getPendingRevision(c, item.slug)?.updatedAt)

const fold = (s: string) => s.normalize('NFKC').toLowerCase()

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** `at`, moved back to the start of the character it falls inside (never the second half of a surrogate pair). */
function characterStart(text: string, at: number): number {
  return at > 0 && at < text.length && isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1)) ? at - 1 : at
}

/** Where `count` characters (code points, so an emoji is one) from `from` end, as an offset in `text`. */
function afterCharacters(text: string, from: number, count: number): number {
  let end = from
  for (let n = 0; n < count && end < text.length; n++) end += isHigh(text.charCodeAt(end)) && end + 1 < text.length && isLow(text.charCodeAt(end + 1)) ? 2 : 1
  return end
}

type Row = Record<string, unknown>

function itemRow(c: AiCollection, item: ItemRecord, ctx: ToolContext): { row: Row; text: string; status: string; tags: string[]; lang: string; flags: { pending: boolean; scheduled: boolean } } {
  const draft = isDraftRow(item)
  const pending = canDraft(ctx) && !draft ? getPendingRevision(c, item.slug) : null
  const shown = pending ?? item
  const fm = (shown.frontmatter ?? {}) as Record<string, unknown>
  const tags = tagsOf(fm[TAG_FIELD[c]])
  const lang = detectContentLang({ lang: fm.lang, title: fm.title, body: shown.body })
  const row: Row = {
    collection: c,
    slug: item.slug,
    title: str(fm.title) || item.slug,
    ...(str(fm.description) ? { description: str(fm.description) } : {}),
    ...(c === 'blog' && str(fm.date) ? { date: str(fm.date) } : {}),
    ...(tags.length ? { tags } : {}),
    lang,
    status: draft ? 'draft' : 'live',
    public_url: draft ? null : publicUrl(c, item.slug),
  }
  let scheduled = false
  if (canDraft(ctx)) {
    const flags = heldFlags(c, item.slug, ctx.now)
    scheduled = flags.scheduled_at !== null
    Object.assign(row, { has_unpublished_changes: pending !== null, ...flags, version: versionOf(c, item), edit_url: editUrl(c, item.slug) })
  }
  const text = [str(fm.title), str(fm.description), tags.join(' '), shown.body ?? ''].join('\n')
  return { row, text, status: row.status as string, tags, lang, flags: { pending: pending !== null, scheduled } }
}

function pageRow(name: PageName, ctx: ToolContext): { row: Row; text: string; lang: string } {
  const page = readPage(name)
  const fm = page.frontmatter ?? {}
  const lang = detectContentLang({ lang: name === 'about-zh' ? 'zh-Hans' : fm.lang, title: fm.title, body: page.body })
  const row: Row = {
    collection: 'page',
    slug: name,
    title: str(fm.title) || name,
    lang,
    status: 'live',
    empty: !page.body.trim(),
    public_url: pagePublicPath(name),
  }
  if (canDraft(ctx)) Object.assign(row, { version: versionEtag(page.updatedAt), edit_url: pageAdminPath(name) })
  return { row, text: [str(fm.title), page.body].join('\n'), lang }
}

export const searchContent = defineTool({
  name: 'search_content',
  title: 'Search content',
  description:
    'Find posts (blog), case studies (work) and single pages (page: now, uses, about, about-zh). Filters are optional and combine: ' +
    'query (words that must all appear in the title, description, tags or text, up to 200 characters), tag, status ' +
    '(live, draft, unpublished_changes, scheduled; anything but live needs draft access), lang (en or zh). ' +
    'limit is 1 to 50 (default 20); pass next_cursor back as cursor for more. Rows carry the slug to use with get_content.',
  scope: 'content:read',
  cost: 'cheap',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: true, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    collection: z.enum(COLLECTIONS).optional().describe('blog, work or page. Absent: all three.'),
    query: z.string().max(200).optional().describe('Words that must all appear (case-insensitive). Up to 200 characters.'),
    tag: z.string().max(100).optional().describe('A tag (posts) or technology (case studies), matched by its slug.'),
    status: z.enum(['live', 'draft', 'unpublished_changes', 'scheduled']).optional().describe('Only items in this state. Anything but live needs draft access.'),
    lang: z.enum(['en', 'zh']).optional().describe('Only items in this language.'),
    limit: z.number().int().min(1).max(50).optional().describe('Rows per page, 1 to 50. Default 20.'),
    cursor: z.string().max(32).optional().describe('next_cursor of the previous page.'),
  }),
  targetOf: () => null,
  read(args, ctx) {
    const status = args.status ?? null
    if (status && status !== 'live' && !canDraft(ctx)) return ok({ items: [], next_cursor: null })
    const words = fold(args.query ?? '').split(/\s+/).filter(Boolean)
    const tag = args.tag !== undefined ? tagSlug(args.tag) : null
    const matches = (text: string, lang: string) => words.every((w) => fold(text).includes(w)) && (!args.lang || lang.startsWith(args.lang))
    const rows: Row[] = []
    for (const c of ['blog', 'work'] as const) {
      if (args.collection && args.collection !== c) continue
      const items = canDraft(ctx) ? listItems(c) : publishedItems(c)
      const sorted = [...items].sort((a, b) => str(b.frontmatter?.date).localeCompare(str(a.frontmatter?.date)) || a.slug.localeCompare(b.slug))
      for (const item of sorted) {
        const r = itemRow(c, item, ctx)
        if (status === 'live' && r.status !== 'live') continue
        if (status === 'draft' && r.status !== 'draft') continue
        if (status === 'unpublished_changes' && !r.flags.pending) continue
        if (status === 'scheduled' && !r.flags.scheduled) continue
        if (tag !== null && !r.tags.some((t) => tagSlug(t) === tag)) continue
        if (!matches(r.text, r.lang)) continue
        rows.push(r.row)
      }
    }
    if ((!args.collection || args.collection === 'page') && tag === null && (status === null || status === 'live')) {
      for (const name of PAGE_NAMES) {
        const r = pageRow(name, ctx)
        if (matches(r.text, r.lang)) rows.push(r.row)
      }
    }
    const page = pageOf(rows, args.cursor, args.limit ?? 20)
    if (!page) return refuse('INVALID_INPUT', 'cursor: pass next_cursor from the previous page, unchanged.')
    return ok(page)
  },
})

export const getContent = defineTool({
  name: 'get_content',
  title: 'Read content',
  description:
    'Read one post (blog), case study (work) or single page (page: now, uses, about, about-zh) by its slug. ' +
    'view latest (default) is what the editor shows, including unpublished changes; live is what visitors see. ' +
    'With draft access the result carries version, which every change must name as base_version. ' +
    'Long text comes in parts: pass next_offset back as offset. limit caps the characters of text (1 to 100000); a character is never split.',
  scope: 'content:read',
  cost: 'cheap',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: true, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    collection: z.enum(COLLECTIONS).describe('blog, work or page.'),
    ref: z.string().min(1).max(128).describe('The slug (blog, work) or the page name (now, uses, about, about-zh).'),
    view: z.enum(['latest', 'live']).optional().describe('latest (default): with unpublished changes. live: as published.'),
    include_body: z.boolean().optional().describe('false leaves the text out. Default true.'),
    offset: z.number().int().min(0).max(10_000_000).optional().describe('Where the text starts, from next_offset. Default 0.'),
    limit: z.number().int().min(1).max(100_000).optional().describe('Most characters of text to return, 1 to 100000.'),
  }),
  targetOf: (args) => ({ kind: args.collection, ref: args.ref }),
  read(args, ctx) {
    /** The rest of the result, then as much of the text as fits beside it. */
    const withBody = (rest: Record<string, unknown>, body: string) => {
      if (args.include_body === false) return { ...rest, body_length: body.length }
      const from = characterStart(body, Math.min(args.offset ?? 0, body.length))
      const capped = body.slice(from, afterCharacters(body, from, args.limit ?? 100_000))
      const budget = Math.max(1024, RESULT_MAX_BYTES - 2048 - byteLength(rest))
      const part = textWindow(capped, 0, budget).text
      const next = from + part.length < body.length ? from + part.length : null
      return { ...rest, body: part, body_length: body.length, offset: from, next_offset: next, truncated: next !== null }
    }

    // The document open in the owner's editor (an assistant run attached to it, §7.8): what the editor holds now,
    // unsaved edits included, at the version the editor loaded. A change to it goes to that editor.
    const inEditor = args.view !== 'live' ? (args.collection === 'page' ? editorOfPage(ctx.editor, args.ref) : editorOfItem(ctx.editor, args.collection, args.ref)) : null

    if (args.collection === 'page') {
      if (!isPageName(args.ref)) return refuse('NOT_FOUND', NOT_PUBLISHED)
      const page = readPage(args.ref)
      if (inEditor) {
        const fm = inEditor.state.frontmatter
        return ok(
          withBody(
            {
              collection: 'page',
              slug: args.ref,
              title: str(fm.title) || args.ref,
              status: 'live',
              view: 'editor',
              in_editor: true,
              unsaved_edits: inEditor.dirty,
              frontmatter: shownFrontmatter(fm),
              public_url: pagePublicPath(args.ref),
              version: inEditor.version,
              edit_url: pageAdminPath(args.ref),
            },
            inEditor.state.body,
          ),
        )
      }
      return ok(
        withBody(
          {
            collection: 'page',
            slug: args.ref,
            title: str(page.frontmatter?.title) || args.ref,
            status: 'live',
            frontmatter: page.frontmatter ?? {},
            public_url: pagePublicPath(args.ref),
            ...(canDraft(ctx) ? { version: versionEtag(page.updatedAt), edit_url: pageAdminPath(args.ref) } : {}),
          },
          page.body,
        ),
      )
    }

    const c = args.collection
    const item = isSafeSlug(args.ref) ? getItem(c, args.ref) : null
    // A draft without draft access is an unknown address, byte for byte.
    if (!item || (isDraftRow(item) && !canDraft(ctx))) return refuse('NOT_FOUND', NOT_PUBLISHED)
    const draft = isDraftRow(item)
    if (inEditor && canDraft(ctx)) {
      const fm = inEditor.state.frontmatter
      return ok(
        withBody(
          {
            collection: c,
            slug: item.slug,
            title: str(fm.title) || item.slug,
            status: draft ? 'draft' : 'live',
            view: 'editor',
            in_editor: true,
            unsaved_edits: inEditor.dirty,
            frontmatter: shownFrontmatter(fm),
            public_url: draft ? null : publicUrl(c, item.slug),
            version: inEditor.version,
            ...heldFlags(c, item.slug, ctx.now),
            edit_url: editUrl(c, item.slug),
          },
          inEditor.state.body,
        ),
      )
    }
    const pending = canDraft(ctx) && !draft ? getPendingRevision(c, item.slug) : null
    const view = args.view === 'live' ? 'live' : 'latest'
    const shown = view === 'latest' && pending ? pending : item
    return ok(
      withBody(
        {
          collection: c,
          slug: item.slug,
          title: str(shown.frontmatter?.title) || item.slug,
          status: draft ? 'draft' : 'live',
          view,
          frontmatter: shownFrontmatter(shown.frontmatter),
          public_url: draft ? null : publicUrl(c, item.slug),
          ...(canDraft(ctx)
            ? { version: versionOf(c, item), has_unpublished_changes: pending !== null, ...heldFlags(c, item.slug, ctx.now), edit_url: editUrl(c, item.slug) }
            : {}),
        },
        shown.body ?? '',
      ),
    )
  },
})
