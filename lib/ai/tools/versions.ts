import * as z from 'zod'
import { versionActions } from '../../audit/store'
import { listSnapshots as listCvSnapshots } from '../../cvdata'
import { listHomeSnapshots } from '../../home'
import { isPageName, isSafeSlug, listDeleted, listSnapshots } from '../../mdx-admin'
import { defineTool, fitItems, ok, refuse, READ_ANNOTATIONS } from '../toolTypes'

/**
 * list_versions (design §4.2): the history of a post, case study, page, the
 * home page or the CV — file name, time, and the action code of the change
 * that replaced each version (post.save, home.restore …). Never the
 * activity log's summary (it can quote a title a model wrote) and never a
 * device. No tool reads a version's content: restoring one is a proposal the
 * owner approves.
 *
 * Read-only listing functions only (lib/mdx-admin, lib/cvdata, lib/home,
 * lib/audit/store): the tool layer never imports lib/contentOps/versions,
 * which holds the restore (design §12.1 boundary).
 */

const KINDS = ['blog', 'work', 'page', 'home', 'cv'] as const
const MAX_ROWS = 50

/** `cv_2025-09-09_03-17-28-947.json` → its UTC time (ISO), or null. */
function jsonSnapshotDate(name: string): string | null {
  const m = /^(?:cv|home)_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})\.json$/.exec(name)
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null
}

export const listVersions = defineTool({
  name: 'list_versions',
  title: 'List versions',
  description:
    'List the saved versions of a post (blog), case study (work), page (now, uses, about, about-zh), the home page or the CV, newest first: ' +
    'file name, time and the action that replaced it (for example post.save). ref is the slug or page name (not used for home and cv). ' +
    'deleted true lists deleted posts or case studies that can still be restored. Restoring a version is a proposal the owner approves.',
  scope: 'content:draft',
  cost: 'cheap',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: true, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    collection: z.enum(KINDS).describe('blog, work, page, home or cv.'),
    ref: z.string().min(1).max(128).optional().describe('The slug (blog, work) or page name. Required for blog, work and page unless deleted is true.'),
    deleted: z.boolean().optional().describe('true: deleted posts or case studies (blog, work only). Default false.'),
  }),
  targetOf: (args) => ({ kind: args.collection, ref: args.ref ?? args.collection }),
  read(args) {
    const c = args.collection
    if (args.deleted) {
      if (c !== 'blog' && c !== 'work') return refuse('INVALID_INPUT', 'deleted: only blog and work keep deleted items.')
      const rows = listDeleted(c, MAX_ROWS).map((d) => ({ slug: d.slug, filename: d.filename, date: d.date }))
      return ok({ collection: c, deleted: fitItems(rows) })
    }
    if (c === 'home' || c === 'cv') {
      const files = (c === 'home' ? listHomeSnapshots() : listCvSnapshots()).slice(0, MAX_ROWS)
      const actions = versionActions(c, files)
      const rows = files.map((f) => ({ filename: f, date: jsonSnapshotDate(f), replaced_by: actions.get(f)?.action ?? null }))
      return ok({ collection: c, versions: fitItems(rows) })
    }
    const ref = args.ref ?? ''
    if (c === 'page' ? !isPageName(ref) : !isSafeSlug(ref)) {
      return refuse('INVALID_INPUT', c === 'page' ? 'ref: one of now, uses, about, about-zh.' : 'ref: the slug of the item (search_content finds it).')
    }
    const list = listSnapshots(c, ref).slice(0, MAX_ROWS)
    const actions = versionActions(c, list.map((s) => s.filename))
    const rows = list.map((s) => ({ filename: s.filename, date: s.date, replaced_by: actions.get(s.filename)?.action ?? null }))
    return ok({ collection: c, ref, versions: fitItems(rows) })
  },
})
