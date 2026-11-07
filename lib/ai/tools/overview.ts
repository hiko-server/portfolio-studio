import * as z from 'zod'
import { listItems } from '../../contentStore'
import { getDb } from '../../db'
import { PAGE_NAMES, readPage } from '../../mdx-admin'
import { pagePublicPath } from '../../pageNames'
import { listPendingRevisions } from '../../pendingRevisions'
import { scheduledEntries } from '../../schedule/store'
import { TAG_FIELD, tagInventory, tagsOf } from '../../tagAdmin'
import { aiHealthView } from '../healthView'
import { READ_ANNOTATIONS, defineTool, ok, type ToolContext } from '../toolTypes'
import { aiHomeView, isDraftRow } from '../views'

/**
 * get_site_overview (design §4.2): what the site holds, in counts, built
 * from the content store directly — never lib/adminAuth/overview's
 * readOverview, which also reads the inbox, error reports and security
 * state. Without draft access drafts are counts only, and the tag list
 * counts published items only (a draft-only tag can name unreleased work);
 * with it, drafts and scheduled items are listed by slug and title.
 */

const LIST_MAX = 50
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const canDraft = (ctx: ToolContext) => ctx.scopes.has('content:draft')

function siteOrigin(): string | null {
  try {
    return (process.env.SITE_URL || '').trim() ? new URL(String(process.env.SITE_URL)).origin : null
  } catch {
    return null
  }
}

function tagsFor(c: 'blog' | 'work', drafts: boolean) {
  const field = TAG_FIELD[c]
  const items = listItems(c).filter((i) => drafts || !isDraftRow(i))
  const pending = drafts ? new Map(listPendingRevisions(c).map((p) => [p.slug, p])) : new Map()
  const inventory = tagInventory(
    items.map((i) => ({
      slug: i.slug,
      title: str(i.frontmatter?.title) || i.slug,
      tags: tagsOf(i.frontmatter?.[field]),
      draft: isDraftRow(i),
      pendingTags: pending.has(i.slug) ? tagsOf(pending.get(i.slug)?.frontmatter?.[field]) : null,
    })),
  )
  return inventory
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug))
    .slice(0, LIST_MAX)
    .map((t) => ({ tag: t.label, slug: t.slug, count: t.count }))
}

export const getSiteOverview = defineTool({
  name: 'get_site_overview',
  title: 'Site overview',
  description:
    'A summary of the site: how many posts and case studies are published (and, with draft access, which drafts and scheduled items exist), ' +
    'which single pages have text, the most used tags, how many images are uploaded and the content health counts. Start here.',
  scope: 'content:read',
  cost: 'expensive',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: true, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({}),
  targetOf: () => null,
  read(_args, ctx) {
    const drafts = canDraft(ctx)
    const collections = (['blog', 'work'] as const).map((c) => {
      const all = listItems(c)
      const draftRows = all.filter(isDraftRow)
      const pending = new Set(listPendingRevisions(c).map((p) => p.slug))
      return {
        collection: c,
        published: all.length - draftRows.length,
        drafts: draftRows.length,
        ...(drafts
          ? {
              with_unpublished_changes: all.filter((i) => !isDraftRow(i) && pending.has(i.slug)).length,
              draft_items: draftRows.slice(0, LIST_MAX).map((i) => ({ slug: i.slug, title: str(i.frontmatter?.title) || i.slug })),
            }
          : {}),
        top_tags: tagsFor(c, drafts),
      }
    })
    const scheduled = scheduledEntries()
    const uploads = (getDb().prepare('SELECT COUNT(*) AS n FROM media_assets a WHERE NOT EXISTS (SELECT 1 FROM media_trash t WHERE t.name = a.name)').get() as { n: number }).n
    const home = aiHomeView().home
    return ok({
      site: { url: siteOrigin(), name: str(home?.site?.name) || null, languages: ['en', 'zh'] },
      collections,
      pages: PAGE_NAMES.map((name) => ({ name, has_text: readPage(name).body.trim() !== '', public_url: pagePublicPath(name) })),
      scheduled: drafts
        ? scheduled.slice(0, LIST_MAX).map((e) => ({ collection: e.collection, slug: e.slug, title: e.title, action: e.kind, at: new Date(e.at).toISOString() }))
        : { count: scheduled.length },
      media: { uploads: Number(uploads) || 0 },
      health: aiHealthView(ctx.now, undefined, { drafts }).counts,
    })
  },
})
