import type { NextApiResponse } from 'next'
import { getItem, listItems } from '../contentStore'
import { normalizeTranslationKey } from '../translations'
import {
  COLLECTION_EXTRA_PATHS,
  CV_DOCUMENT_PATHS,
  CV_PAGE_PATHS,
  HOME_PAGE_PATHS,
  collectionPaths,
  pageRevalidatePaths,
  revalidatePaths,
} from '../revalidate'
import { warmCvExports } from '../cvExport/service'
import type { PageName } from '../pageNames'

/**
 * Which public pages a content write regenerates, and the regeneration
 * itself — one place for the admin routes and for any server code that
 * writes content outside a route's own handler (the scheduler, an approved
 * AI change), so none of them imports a route module to refresh what it
 * changed. SERVER-ONLY.
 *
 * Every helper takes the route's real response (`res.revalidate` goes
 * through Next's own revalidation and works while a stream is open), never
 * fails the write it follows (the content is already stored; the ISR window
 * still applies) and answers `{ revalidated, revalidateFailed? }` for the
 * route's JSON. Each successful regeneration also clears the search index
 * and notifies the edge (lib/revalidate revalidatePaths).
 */

export type Collection = 'blog' | 'work'

/** What a regeneration did: the pages refreshed, and those that could not be. */
export type Refreshed = { revalidated: string[]; revalidateFailed?: string[] }

/**
 * A post or case-study write that still needs its public pages regenerated:
 * returned by the item services (lib/contentOps/items) for the caller that
 * holds a response to run refreshCollection with.
 */
export type CollectionRefresh = { collection: Collection; slug: string; previousKeys: unknown[] }

type PublicationsNav = { pathsIfChanged: () => string[] }

const refreshed = (paths: readonly string[], failed: readonly string[]): Refreshed => ({
  revalidated: paths.filter((p) => !failed.includes(p)),
  ...(failed.length ? { revalidateFailed: [...failed] } : {}),
})

// ── Posts and case studies ─────────────────────────────────────────────────

/**
 * Slugs of the items that carry one of `keys` as their translation key
 * (lib/translations): the other language versions of a piece, whose
 * language switch, hreflang and index entry name it.
 */
export function translationPartners(c: Collection, keys: readonly unknown[]): string[] {
  const wanted = new Set(keys.map(normalizeTranslationKey).filter(Boolean))
  if (!wanted.size) return []
  return listItems(c)
    .filter((item) => wanted.has(normalizeTranslationKey(item.frontmatter?.translationKey)))
    .map((item) => item.slug)
}

/**
 * Public pages to regenerate after a write to `slug`: the index, the item,
 * its siblings (prev/next and related links), the pages outside the
 * collection that list or link it (COLLECTION_EXTRA_PATHS: the home page's
 * latest writing, case-study links on / and /about) and the CV pages (their
 * skill evidence cites posts and case studies, and projects link their case
 * study). Its translations (F2) come first among the siblings, so the cap
 * never leaves out a page whose language switch names it: those of the
 * item's key as stored now, and of `previousKeys` (the key before the write
 * or delete — a version that left a group must vanish from its partners).
 * A failed refresh never fails the write (the ISR window still applies).
 */
export async function refreshCollection(res: NextApiResponse, c: Collection, slug: string, previousKeys: readonly unknown[] = []): Promise<Refreshed> {
  const partners = translationPartners(c, [getItem(c, slug)?.frontmatter?.translationKey, ...previousKeys])
  const siblings = [...partners, ...listItems(c).map((i) => i.slug)]
  const paths = [...collectionPaths(c, slug, siblings), ...COLLECTION_EXTRA_PATHS[c], ...CV_DOCUMENT_PATHS]
  const failed = await revalidatePaths(res, paths)
  return refreshed(paths, failed)
}

// ── Single pages (/now, /uses, the bios) ───────────────────────────────────

/**
 * Regenerate a single page after a write or restore: the page itself (the
 * Chinese bio publishes /zh/about: /about and the Chinese pages follow,
 * lib/revalidate pageRevalidatePaths).
 */
export async function refreshPage(res: NextApiResponse, name: PageName): Promise<Refreshed> {
  const paths = pageRevalidatePaths(name)
  const failed = await revalidatePaths(res, paths)
  return refreshed(paths, failed)
}

// ── The home and CV documents ──────────────────────────────────────────────

/**
 * Statically generated (ISR) pages that render home data, regenerated after a
 * save or restore (lib/revalidate.ts HOME_PAGE_PATHS: / and /about render
 * the hero, portrait, socials and availability; /now shows
 * hero.currentlyCoding; /contact the contact copy, reasons, availability and
 * e-mail / phone; /cv and /cv/zh show the socials — header, GitHub /
 * LinkedIn fallbacks — the portrait and the availability lines).
 * pages/api/home re-exports it.
 */
export const HOME_STATIC_PATHS: readonly string[] = [...HOME_PAGE_PATHS]

/**
 * Statically generated (ISR) pages that render CV data, regenerated after a
 * save, restore or import so an entry the owner just hid is not served from
 * the ISR cache (lib/revalidate.ts CV_PAGE_PATHS: /, /about, /now, /work —
 * whose archive lists every public project — the CV itself, /cv and /cv/zh,
 * and /publications, rendered from the Publications section).
 * pages/api/cvdata re-exports it.
 */
export const CV_STATIC_PATHS: readonly string[] = [...CV_PAGE_PATHS]

/**
 * Regenerate home-backed static pages and re-render the PDF CVs in the
 * background (their header shows the socials and the availability lines);
 * never fails the (already stored) write. Used by /api/home's save and
 * restore.
 */
export async function refreshHome(res: NextApiResponse): Promise<Refreshed> {
  const paths = [...HOME_STATIC_PATHS]
  warmCvExports()
  const failed = await revalidatePaths(res, paths, { confirm: paths })
  return refreshed(paths, failed)
}

/**
 * Regenerate CV-backed static pages and re-render the downloadable PDFs in
 * the background; never fails the (already stored) write. `nav`
 * (lib/publicationsNav trackPublicationsNav, taken before the write) adds
 * the other ISR pages when /publications appeared or disappeared, so their
 * nav link follows. Used by /api/cvdata's save, restore and import.
 */
export async function refreshCv(res: NextApiResponse, nav?: PublicationsNav): Promise<Refreshed> {
  const paths = Array.from(new Set([...CV_STATIC_PATHS, ...(nav ? nav.pathsIfChanged() : [])]))
  warmCvExports()
  const failed = await revalidatePaths(res, paths, { confirm: paths })
  return refreshed(paths, failed)
}

type JsonDocType = 'cv' | 'home'

/**
 * Statically generated (ISR) pages rendered from each document
 * (lib/revalidate.ts CV_PAGE_PATHS / HOME_PAGE_PATHS: /, /about, /now, the
 * CV pages, /work and /publications for the CV and /contact for the home
 * document), so restoring either one from the version history
 * (/api/versions) regenerates them instead of leaving the ISR copy live.
 */
const STATIC_PATHS: Record<JsonDocType, string[]> = { cv: [...CV_PAGE_PATHS], home: [...HOME_PAGE_PATHS] }

/**
 * Regenerate after a version-history restore of the CV or the home document
 * (/api/versions). A restore that makes /publications appear or disappear
 * (`nav`, taken before it) also refreshes the nav link of the other ISR
 * pages; a CV restore re-renders the PDFs in the background.
 */
export async function refreshRestoredDoc(res: NextApiResponse, type: JsonDocType, nav: PublicationsNav | null): Promise<Refreshed> {
  const paths = Array.from(new Set([...STATIC_PATHS[type], ...(nav ? nav.pathsIfChanged() : [])]))
  if (type === 'cv') warmCvExports()
  const failed = await revalidatePaths(res, paths, { confirm: paths })
  return refreshed(paths, failed)
}
