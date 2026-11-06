import type { StoreError } from '../contentStore'
import { ifMatchAllows } from '../contentStore'
import { isPageName, mdxProblem, readPage, versionEtag, writePage, type MdxProblem, type PageName } from '../mdx-admin'
import { ensurePosters } from '../videoPoster'

/**
 * The write of a single MDX page (/now, /uses, the /about bio and the
 * Chinese bio of /zh/about, lib/pageNames), shared by its admin route
 * (pages/api/admin/page) and by an approved AI proposal (lib/ai/apply), so
 * both run the same checks in the same order. SERVER-ONLY.
 *
 * Returns a discriminated union and never touches an HTTP response: a
 * failure carries the status and body the admin API answers with. The
 * caller holding the response regenerates the page (lib/revalidate
 * pageRevalidatePaths).
 *
 * What stays with the route: authorisation and the rate limit.
 */

export type PageProblem =
  | { ok: false; status: 400; code: 'BAD_REQUEST'; error: string }
  | { ok: false; status: 409; code: 'VERSION_CONFLICT'; error: string; etag: string }
  | { ok: false; status: 422; code: 'MDX_INVALID'; problem: MdxProblem }
  | { ok: false; status: 400; code: 'STORE_ERROR'; error: string }

export type SavePageResult = { ok: true; name: PageName; stored: Extract<StoreError, { ok: true }>; etag: string } | PageProblem

export type SavePageInput = {
  name: unknown
  frontmatter: unknown
  body: unknown
  /** The admin route's If-Match header: absent or empty means last write wins. */
  ifMatch?: string | string[]
  /** Any other caller: the one exact version (`"<updated_at>"`, quotes optional) the change was made from. */
  version?: string
}

const badRequest = (error: string): PageProblem => ({ ok: false, status: 400, code: 'BAD_REQUEST', error })

/** The exact page version a non-route caller names, as versionEtag writes it, or null. */
export function exactPageVersion(version: unknown): string | null {
  if (typeof version !== 'string') return null
  const inner = version.trim().replace(/^"(.*)"$/, '$1')
  return /^\d+$/.test(inner) ? `"${inner}"` : null
}

/**
 * Save a page: `frontmatter.title` is required; a non-empty body must compile
 * with the public renderer (422, nothing written) and its video posters are
 * imported first. An empty body switches /now and /uses back to their
 * automatic version and takes the bio off /about. The version check and the
 * write run without an await in between (single Node process).
 */
export async function savePageDoc(input: SavePageInput): Promise<SavePageResult> {
  const { name, frontmatter, body } = input
  if (!isPageName(name)) return badRequest('Invalid page name')
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return badRequest('Missing frontmatter')
  const fm = frontmatter as Record<string, any>
  if (!fm.title) return badRequest('frontmatter.title required')
  if (body !== undefined && typeof body !== 'string') return badRequest('body must be a string')
  const exact = input.version === undefined ? null : exactPageVersion(input.version)
  if (input.version !== undefined && !exact) return badRequest('Name exactly one version of the page, as it was read')
  const text = body || ''

  if (text.trim()) {
    const problem = await mdxProblem(text)
    if (problem) return { ok: false, status: 422, code: 'MDX_INVALID', problem }
    await ensurePosters(text)
  }

  const current = readPage(name).updatedAt
  const allowed = exact !== null ? exact === versionEtag(current) : ifMatchAllows(input.ifMatch, current)
  if (!allowed) return { ok: false, status: 409, code: 'VERSION_CONFLICT', error: 'This was changed elsewhere since you loaded it', etag: versionEtag(current) }
  const result = await writePage(name, fm, text)
  if (!result.ok) return { ok: false, status: 400, code: 'STORE_ERROR', error: result.error }
  return { ok: true, name, stored: result, etag: versionEtag(readPage(name).updatedAt) }
}
