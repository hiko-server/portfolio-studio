import { listItems, type ItemRecord } from '../contentStore'
import { readPublicCvData } from '../cvdata'
import { CV_SECTIONS, type FieldDef, type ListDef } from '../cvSections'
import type { CvDoc, CvSectionLike } from '../cvVisibility'
import { readHomeWithVersion, publicHome, type HomeData } from '../home'
import { getPendingRevision } from '../pendingRevisions'
import { linkSlugsOf, listReviewLinks } from '../review/store'
import { scheduleOf } from '../schedule/store'

/**
 * What the AI tools read (SERVER-ONLY, design §4.2, §5.7): the public views,
 * never the stored documents. A hidden value cannot be copied, rewritten or
 * summarised because no tool can read it.
 *
 *   - Home: publicHome() (hidden photos and switched-off sections removed),
 *     minus the contact fields the site shows only where the owner put them
 *     (hero.phone, hero.email, socials.whatsapp).
 *   - CV: readPublicCvData('any', 'web') — hidden sections, entries, fields
 *     and list items, consent lists and the PDF photo never leave — with
 *     entry uids kept (so a later proposal can name an entry), minus every
 *     contact field (AI_CV_STRIP: phone, e-mail, address; any `tel` or
 *     `email` field of lib/cvSections), so a model cannot copy what it reads
 *     there into a post.
 *   - Items: the published rows (not drafts) for everyone; drafts and
 *     unpublished changes only for a caller holding content:draft, which the
 *     tools check themselves.
 *
 * Review links: only whether an item has active ones (a held item cannot be
 * edited in place, §4.6). Their addresses and tokens never leave lib/review.
 */

/** Home fields a tool never reads (§4.2), as paths into the public view. */
export const AI_HOME_STRIP: ReadonlyArray<readonly [string, string]> = [
  ['hero', 'phone'],
  ['hero', 'email'],
  ['socials', 'whatsapp'],
]

/** The home page as visitors see it, without its contact fields, and its version; null when there is none. */
export function aiHomeView(): { home: HomeData | null; version: number } {
  const { home, version } = readHomeWithVersion()
  const view = publicHome(home)
  if (!view) return { home: null, version }
  const out: Record<string, any> = { ...view }
  for (const [group, key] of AI_HOME_STRIP) {
    const g = out[group]
    if (g && typeof g === 'object' && !Array.isArray(g) && key in g) {
      const copy = { ...g }
      delete copy[key]
      out[group] = copy
    }
  }
  return { home: out as HomeData, version }
}

function contactKeys(fields: readonly FieldDef[] | undefined, lists: readonly ListDef[] | undefined, into: Set<string>): Set<string> {
  for (const f of fields ?? []) if (f.kind === 'tel' || f.kind === 'email') into.add(f.key)
  for (const l of lists ?? []) contactKeys(l.fields, l.lists, into)
  return into
}

/**
 * The CV fields no tool reads, per section: every `tel` and `email` field of
 * the registry at any depth, and the personal address.
 */
export const AI_CV_STRIP: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    CV_SECTIONS.map((s) => {
      const keys = contactKeys(s.fields, s.lists, new Set())
      if (s.sessionName === 'personalInformation') keys.add('address')
      return [s.sessionName, Array.from(keys).sort()] as const
    }).filter(([, keys]) => keys.length > 0),
  ),
)

function stripKeys(node: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((v) => stripKeys(v, keys))
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (keys.has(k)) continue
    out[k] = stripKeys(v, keys)
  }
  return out
}

/** The CV as visitors see it on the website (both languages), entry uids kept, contact fields removed. */
export function aiCvView(): CvDoc {
  const doc = readPublicCvData('any', 'web', undefined, { keepUids: true })
  const strip = (sections: CvSectionLike[]) =>
    sections.map((s) => {
      const keys = AI_CV_STRIP[String(s.sessionName ?? '')]
      return keys ? (stripKeys(s, new Set(keys)) as CvSectionLike) : s
    })
  return { en: strip(doc.en), zh: strip(doc.zh) }
}

export type AiCollection = 'blog' | 'work'

/** A stored item counts as a draft when its `draft` flag is truthy (lib/mdx's rule). */
export const isDraftRow = (item: Pick<ItemRecord, 'frontmatter'>) => Boolean(item.frontmatter?.draft)

/** The published items of a collection (what visitors can open), newest change first. */
export function publishedItems(c: AiCollection): ItemRecord[] {
  return listItems(c).filter((i) => !isDraftRow(i))
}

/** Active review links that show this item (at its slug or an old slug that leads to it). */
export function activeReviewLinks(c: AiCollection, slug: string, now = Date.now()): number {
  return listReviewLinks({ collection: c, slugs: linkSlugsOf(c, slug), now }).length
}

/**
 * What a writer must know before it edits an item (§4.6): when it is
 * scheduled to go live (ISO, or null) and whether review links show it. Owner-only facts: callers
 * return them only to content:draft.
 */
export function heldFlags(c: AiCollection, slug: string, now = Date.now()): { scheduled_at: string | null; in_review: boolean } {
  const { publishAt } = scheduleOf(c, slug)
  return { scheduled_at: publishAt === null ? null : new Date(publishAt).toISOString(), in_review: activeReviewLinks(c, slug, now) > 0 }
}

/** The unpublished changes of a live item, or null (a draft never holds any). */
export function pendingOf(c: AiCollection, item: Pick<ItemRecord, 'slug' | 'frontmatter'>) {
  return isDraftRow(item) ? null : getPendingRevision(c, item.slug)
}
