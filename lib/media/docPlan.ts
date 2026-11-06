import { listItems } from '../contentStore'
import { listPendingRevisions } from '../pendingRevisions'
import { COLLECTION_EXTRA_PATHS, CV_PAGE_PATHS, HOME_PAGE_PATHS, collectionPaths, pageRevalidatePaths } from '../revalidate'
import { pageFixedLang, type PageName } from '../pageNames'
import { detectContentLang } from '../toc'
import { pageDocTitle } from './usage'

/**
 * Which stored documents a media change would rewrite, and how — the dry
 * run of lib/media/docRewrite (SERVER-ONLY, reads only). "Replace file" and
 * "Use the default alt text" transform every post, case study (the live
 * version and the unpublished changes), page, the CV and the home page;
 * this computes each changed document's text before and after without
 * writing anything, so lib/media/docRewrite can write exactly these and an
 * AI alt-text proposal (lib/ai/plans) can show them first. No writer is
 * imported here.
 */

export type MdxDoc = { frontmatter: Record<string, unknown>; body: string }
export type Rewrite<T> = { value: T; count: number }
/** `lang`: the document's language (frontmatter `lang`, else detected — lib/toc). */
export type MdxTransform = (doc: MdxDoc, ctx: { lang: string }) => Rewrite<MdxDoc>
export type JsonTransform = (value: unknown) => Rewrite<unknown>

export type RewrittenDoc = { kind: 'post' | 'work' | 'page' | 'cv' | 'home'; ref: string; title: string; references: number }

/** One row of a document, as stored and as the transform would store it (`count` 0: unchanged). */
export type PlannedRow = { before: MdxDoc; after: MdxDoc; count: number }

type PlannedBase = {
  target: RewrittenDoc
  /** Public pages to regenerate once it is written. */
  paths: string[]
  /** The MDX bodies the change would store (each must compile before anything is written). */
  bodies: string[]
}

export type PlannedDoc =
  | (PlannedBase & { kind: 'item'; collection: 'blog' | 'work'; slug: string; draft: boolean; live: PlannedRow; pending: PlannedRow | null })
  | (PlannedBase & { kind: 'page'; name: PageName; row: PlannedRow })
  | (PlannedBase & { kind: 'cv' | 'home'; before: unknown; after: unknown })

const titleOf = (fm: Record<string, unknown> | undefined, fallback: string) =>
  typeof fm?.title === 'string' && fm.title.trim() ? fm.title.trim() : fallback

const langOf = (doc: MdxDoc, fixed: string | null = null) =>
  detectContentLang({ lang: doc.frontmatter?.lang || fixed || undefined, title: doc.frontmatter?.title, body: doc.body })

/** Every document the transforms change, with its text before and after. Writes nothing. */
export async function planDocuments(mdx: MdxTransform, json: { cv?: JsonTransform; home?: JsonTransform } = {}): Promise<PlannedDoc[]> {
  const planned: PlannedDoc[] = []
  for (const c of ['blog', 'work'] as const) {
    const pending = new Map(listPendingRevisions(c).map((p) => [p.slug, p]))
    for (const item of listItems(c)) {
      const slug = item.slug
      const liveDoc = { frontmatter: item.frontmatter as Record<string, unknown>, body: item.body }
      const live = mdx(liveDoc, { lang: langOf(liveDoc) })
      const rev = pending.get(slug)
      const revDoc = rev ? { frontmatter: rev.frontmatter as Record<string, unknown>, body: rev.body } : null
      const pend = revDoc ? mdx(revDoc, { lang: langOf(revDoc) }) : null
      const references = live.count + (pend?.count ?? 0)
      if (!references) continue
      const draft = !!item.frontmatter?.draft
      planned.push({
        kind: 'item',
        collection: c,
        slug,
        draft,
        target: { kind: c === 'blog' ? 'post' : 'work', ref: slug, title: titleOf(item.frontmatter, slug), references },
        // A live item's page, its collection index and the pages that list it; a draft has none.
        paths: draft || !live.count ? [] : [...collectionPaths(c, slug), ...COLLECTION_EXTRA_PATHS[c]],
        bodies: [...(live.count ? [live.value.body] : []), ...(pend && pend.count ? [pend.value.body] : [])],
        live: { before: liveDoc, after: live.value, count: live.count },
        pending: revDoc && pend ? { before: revDoc, after: pend.value, count: pend.count } : null,
      })
    }
  }

  const { PAGE_NAMES, readPage } = await import('../mdx-admin')
  for (const name of PAGE_NAMES) {
    const page = readPage(name)
    if (!page.updatedAt && !page.body) continue
    const doc = { frontmatter: page.frontmatter as Record<string, unknown>, body: page.body }
    // The Chinese bio is Chinese by its name, whatever its text looks like (lib/mdx getStaticMdxPage).
    const r = mdx(doc, { lang: langOf(doc, pageFixedLang(name)) })
    if (!r.count) continue
    planned.push({
      kind: 'page',
      name,
      target: { kind: 'page', ref: name, title: pageDocTitle(name), references: r.count },
      // Where it is public (/zh/about for the Chinese bio) and the pages that depend on it, like a save.
      paths: pageRevalidatePaths(name),
      bodies: [r.value.body],
      row: { before: doc, after: r.value, count: r.count },
    })
  }

  if (json.cv) {
    const { readCvData } = await import('../cvdata')
    const before = readCvData()
    const cv = json.cv(before)
    if (cv.count) planned.push({ kind: 'cv', target: { kind: 'cv', ref: 'cv', title: 'CV', references: cv.count }, paths: [...CV_PAGE_PATHS], bodies: [], before, after: cv.value })
  }

  if (json.home) {
    const { readHome } = await import('../home')
    const homeDoc = readHome()
    if (homeDoc) {
      const home = json.home(homeDoc)
      if (home.count) {
        planned.push({ kind: 'home', target: { kind: 'home', ref: 'home', title: 'Home page', references: home.count }, paths: [...HOME_PAGE_PATHS], bodies: [], before: homeDoc, after: home.value })
      }
    }
  }
  return planned
}
