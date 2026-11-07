import { log } from '../log'
import { getItem } from '../contentStore'
import { getPendingRevision, putPendingRevision, rebasedPendingBase } from '../pendingRevisions'
import { planDocuments, type JsonTransform, type MdxTransform, type PlannedDoc, type RewrittenDoc } from './docPlan'

/**
 * Rewriting stored documents for the media library (H7) — SERVER-ONLY.
 * "Replace file" points every reference at the new file; "Use the default
 * alt text" fills in missing alt texts. Both go through here, the way a
 * save does: posts and case studies (the live version and the unpublished
 * changes, which stay based on the live version when they were), the /now,
 * /uses and /about pages (English and Chinese bios), the CV and the home
 * page — each snapshotted first (the activity log links the snapshots to the
 * change) — and say which public pages to regenerate.
 *
 * What changes is computed first, without writing (lib/media/docPlan, the
 * dry run an AI alt-text proposal shows the owner); this writes it.
 *
 * Like every other write path (the editors' PUT, content-health fixes,
 * scheduled publishing), a rewritten post, case-study or page body must
 * still compile with the public renderer (lib/mdx-admin mdxProblem): a
 * document that would not is left exactly as it is and reported in
 * `skipped`, so one image can never take a page, the feeds or the Markdown
 * twins down behind a success message.
 */

export type { MdxDoc, MdxTransform, JsonTransform, Rewrite, RewrittenDoc } from './docPlan'

/** A document left unchanged, and why (shown to the owner). */
export type SkippedDoc = RewrittenDoc & { reason: string }

type Applied = { ok: true; warning: string | null } | { ok: false; error: string }
/** `bodies`: the MDX bodies the change would store (checked before anything is written). */
type DocChange = { target: RewrittenDoc; paths: string[]; bodies: string[]; apply: () => Promise<Applied> }

/** The write of one planned document (lib/media/docPlan), the way a save writes it. */
function writerOf(doc: PlannedDoc): () => Promise<Applied> {
  if (doc.kind === 'item') {
    const { collection: c, slug, live, pending: pend } = doc
    return async () => {
      const { writeOne } = await import('../mdx-admin')
      let warning: string | null = null
      const before = getItem(c, slug)?.updated_at ?? 0
      if (live.count) {
        const result = await writeOne(c, slug, live.after.frontmatter as Record<string, any>, live.after.body)
        if (!result.ok) return { ok: false, error: `could not update ${c}/${slug}: ${result.error}` }
        if ('r2Warning' in result && result.r2Warning) warning = result.r2Warning
      }
      const current = getPendingRevision(c, slug)
      if (current) {
        const base = rebasedPendingBase(current.baseUpdatedAt, before, getItem(c, slug)?.updated_at ?? 0)
        const next = pend && pend.count ? pend.after : { frontmatter: current.frontmatter, body: current.body }
        if ((pend && pend.count) || base !== current.baseUpdatedAt) putPendingRevision(c, slug, next.frontmatter as Record<string, any>, next.body, base)
      }
      return { ok: true, warning }
    }
  }
  if (doc.kind === 'page') {
    return async () => {
      const { writePage } = await import('../mdx-admin')
      const result = await writePage(doc.name, doc.row.after.frontmatter as Record<string, any>, doc.row.after.body)
      if (!result.ok) return { ok: false, error: `could not update ${doc.target.title}: ${result.error}` }
      return { ok: true, warning: 'r2Warning' in result && result.r2Warning ? result.r2Warning : null }
    }
  }
  if (doc.kind === 'cv') {
    return async () => {
      const { saveSnapshot, writeCvData } = await import('../cvdata')
      saveSnapshot()
      const result = await writeCvData(doc.after as Parameters<typeof writeCvData>[0])
      return result.ok ? { ok: true, warning: result.r2Warning ?? null } : { ok: false, error: `could not update the CV: ${result.error}` }
    }
  }
  return async () => {
    const { saveHomeSnapshot, writeHome } = await import('../home')
    saveHomeSnapshot()
    const result = await writeHome(doc.after as Parameters<typeof writeHome>[0])
    return result.ok ? { ok: true, warning: result.r2Warning ?? null } : { ok: false, error: `could not update the home page: ${result.error}` }
  }
}

async function collect(mdx: MdxTransform, json: { cv?: JsonTransform; home?: JsonTransform }): Promise<DocChange[]> {
  return (await planDocuments(mdx, json)).map((doc) => ({ target: doc.target, paths: doc.paths, bodies: doc.bodies, apply: writerOf(doc) }))
}

export type RewriteRun = {
  /** The documents rewritten. */
  rewrites: RewrittenDoc[]
  paths: string[]
  warnings: string[]
  /** The documents left unchanged because a rewritten body would no longer compile. */
  skipped: SkippedDoc[]
}

/**
 * Rewrite every document `mdx` (and the CV / home transforms) change; never
 * throws per document. A document whose rewritten body would not compile is
 * skipped (nothing of it is written) and listed in `skipped`.
 */
export async function rewriteDocuments(mdx: MdxTransform, json: { cv?: JsonTransform; home?: JsonTransform } = {}): Promise<RewriteRun> {
  const changes = await collect(mdx, json)
  const { mdxProblem } = await import('../mdx-admin')
  const paths = new Set<string>()
  const warnings: string[] = []
  const rewrites: RewrittenDoc[] = []
  const skipped: SkippedDoc[] = []
  for (const change of changes) {
    try {
      let problem: string | null = null
      for (const body of change.bodies) {
        const p = await mdxProblem(body)
        if (p) {
          problem = p.error
          break
        }
      }
      if (problem) {
        log.warn('media: a document was left unchanged, its new text would not compile', { target: change.target, problem })
        skipped.push({ ...change.target, reason: problem })
        continue
      }
      const out = await change.apply()
      if (!out.ok) {
        warnings.push(out.error)
        continue
      }
      if (out.warning) warnings.push(out.warning)
      rewrites.push(change.target)
      change.paths.forEach((p) => paths.add(p))
    } catch (err) {
      log.error('media: updating a document failed', { err, target: change.target })
      warnings.push(`could not update ${change.target.title}`)
    }
  }
  return { rewrites, paths: Array.from(paths), warnings, skipped }
}
