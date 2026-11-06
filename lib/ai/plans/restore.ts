import { documentText } from '../../../components/Admin/shell/textDiff'
import { kvEtag, safeSnapshotName } from '../../contentStore'
import type { Collection } from '../../contentOps/rules'
import { readCvDataWithVersion, readSnapshot as readCvSnapshot, type FullCvDoc } from '../../cvdata'
import { withEntryUids } from '../../cvEntryUid'
import { publicHome, readHomeSnapshot, readHomeWithVersion } from '../../home'
import { isPageName, parseSnapshotName, readPage, readSnapshot, versionEtag } from '../../mdx-admin'
import { pageAdminPath, pagePublicPath } from '../../pageNames'
import { CV_PAGE_PATHS, HOME_PAGE_PATHS, pageRevalidatePaths } from '../../revalidate'
import { carryScheduleOnSave, withoutSchedule } from '../../schedule/fields'
import type { ToolContext, ToolRefusal } from '../toolTypes'
import { hiddenValuesChanged, itemBefore, itemEditUrl, itemPublicPaths, itemState, needsDraftAccess, noun, prettyJson, refuse, versionProblem } from './common'
import { cvLinks, cvPublicView } from './cv'
import { canonicalJson, type PreviewDocument, type WritePlan } from './types'

/**
 * Plan of `propose_restore` (pure, design §4.2, §4.4): put a version from
 * the history back as the current state of a post, case study, page, the
 * home page or the CV. Destructive: it replaces the whole document, hidden
 * parts included — the one exception to §4.4's invariant — so the card
 * shows the public view (or the text) before and after and states how many
 * hidden values also change, and the approval needs a fresh sign-in.
 */

export type RestoreArgs = { collection: Collection | 'page' | 'home' | 'cv'; ref?: string; filename: string; base_version: string; rationale?: string }

/** An item's text with its published state: a restore can publish a draft or take a post down. */
function restoreText(row: { frontmatter: Record<string, unknown>; body: string } | null): string {
  return row ? documentText(withoutSchedule(row.frontmatter as Record<string, any>), row.body) : ''
}

const SNAPSHOT_NOT_FOUND = 'There is no such version (list them with list_versions).'

/** The stored CV shape of a snapshot: `{ en, zh }`, or a legacy bare array for English (lib/cvdata's rule). */
function cvOf(json: any): FullCvDoc {
  const en = Array.isArray(json?.en) ? json.en : Array.isArray(json) ? json : []
  const zh = Array.isArray(json?.zh) ? json.zh : []
  return withEntryUids({ en, zh })
}

export function planRestore(args: RestoreArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  const kind = args.collection
  const base = { rationale: args.rationale ?? null, held: null, proposal: true }
  const audit = (extra: Record<string, unknown>) => ({ route: 'versions', method: 'POST', body: { type: kind, action: 'restore', filename: args.filename, ...extra } })

  if (kind === 'home' || kind === 'cv') {
    const file = safeSnapshotName(args.filename)
    const raw = file ? (kind === 'home' ? readHomeSnapshot(file) : readCvSnapshot(file)) : null
    if (!file || raw === null) return refuse('NOT_FOUND', SNAPSHOT_NOT_FOUND)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return refuse('INVALID_INPUT', 'That version is not readable, so it cannot be restored.')
    }
    if (kind === 'home') {
      const { home, version } = readHomeWithVersion()
      const stale = versionProblem(args.base_version, kvEtag(version), 'The home page')
      if (stale) return stale
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse('INVALID_INPUT', 'That version does not hold a home document.')
      if (canonicalJson(parsed) === canonicalJson(home)) return refuse('NO_VISIBLE_CHANGE', 'That version is the home page as it is now.')
      const viewBefore = publicHome(home)
      const viewAfter = publicHome(parsed as never)
      return {
        ...base,
        kind: 'home.restore',
        risk: 'destructive',
        target: { kind: 'home', ref: 'home' },
        baseVersion: kvEtag(version),
        args: { collection: 'home', filename: file, base_version: kvEtag(version) },
        before: { kind: 'doc', doc: 'home', value: home, version },
        preview: {
          kind: 'home.restore',
          risk: 'destructive',
          title: `Restore the home page from ${file}`,
          documents: [{ ref: 'home', label: 'Home page as visitors see it', publicUrl: '/', format: 'json', before: prettyJson(viewBefore), after: prettyJson(viewAfter) }],
          effects: { publicPaths: [...HOME_PAGE_PATHS], schedule: null, deleted: false, import: null, hiddenValuesChanged: hiddenValuesChanged({ full: home, view: viewBefore }, { full: parsed, view: viewAfter }) },
        },
        check: { kind: 'documents', documents: [] },
        audit: audit({}),
        editUrl: '/admin/home',
      }
    }
    const read = readCvDataWithVersion()
    const stale = versionProblem(args.base_version, kvEtag(read.version), 'The CV')
    if (stale) return stale
    const current: FullCvDoc = { en: read.en, zh: read.zh }
    const restored = cvOf(parsed)
    if (canonicalJson(restored) === canonicalJson(current)) return refuse('NO_VISIBLE_CHANGE', 'That version is the CV as it is now.')
    const viewBefore = cvPublicView(current)
    const viewAfter = cvPublicView(restored)
    return {
      ...base,
      kind: 'cv.restore',
      risk: 'destructive',
      target: { kind: 'cv', ref: 'cv' },
      baseVersion: kvEtag(read.version),
      args: { collection: 'cv', filename: file, base_version: kvEtag(read.version) },
      before: { kind: 'doc', doc: 'cv', value: current, version: read.version },
      preview: {
        kind: 'cv.restore',
        risk: 'destructive',
        title: `Restore the CV from ${file}`,
        documents: [{ ref: 'cv', label: 'CV as visitors see it', publicUrl: '/cv', format: 'json', before: prettyJson(viewBefore), after: prettyJson(viewAfter) }],
        effects: { publicPaths: [...CV_PAGE_PATHS], schedule: null, deleted: false, import: null, hiddenValuesChanged: hiddenValuesChanged({ full: current, view: viewBefore }, { full: restored, view: viewAfter }) },
      },
      check: { kind: 'documents', documents: [{ format: 'json', strings: [], beforeStrings: [], links: cvLinks(viewAfter), beforeLinks: cvLinks(viewBefore), images: [], beforeImages: [], rewritten: false }] },
      audit: audit({}),
      editUrl: '/admin/dashboard?tab=cv',
    }
  }

  const ref = args.ref ?? ''
  const info = parseSnapshotName(args.filename)
  if (!info || info.slug !== ref) return refuse('NOT_FOUND', SNAPSHOT_NOT_FOUND)

  if (kind === 'page') {
    if (!isPageName(ref)) return refuse('NOT_FOUND', 'There is no page with that name: now, uses, about or about-zh.')
    const doc = readSnapshot('page', info.filename)
    if (!doc) return refuse('NOT_FOUND', SNAPSHOT_NOT_FOUND)
    const page = readPage(ref)
    const version = versionEtag(page.updatedAt)
    const stale = versionProblem(args.base_version, version, 'The page')
    if (stale) return stale
    const beforeText = documentText(page.frontmatter, page.body)
    const afterText = documentText(doc.frontmatter, doc.body)
    if (beforeText === afterText && canonicalJson(page.frontmatter) === canonicalJson(doc.frontmatter)) return refuse('NO_VISIBLE_CHANGE', 'That version is the page as it is now.')
    return {
      ...base,
      kind: 'page.restore',
      risk: 'destructive',
      target: { kind: 'page', ref },
      baseVersion: version,
      args: { collection: 'page', ref, filename: info.filename, base_version: version },
      before: { kind: 'page', name: ref, page: page.updatedAt ? { frontmatter: page.frontmatter, body: page.body, updatedAt: page.updatedAt } : null },
      preview: {
        kind: 'page.restore',
        risk: 'destructive',
        title: `Restore page ${ref} from ${info.filename}`,
        documents: [{ ref: `page/${ref}`, label: `Page ${pagePublicPath(ref)}`, publicUrl: pagePublicPath(ref), format: 'mdx', before: beforeText, after: afterText }],
        effects: { publicPaths: pageRevalidatePaths(ref), schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
      },
      check: { kind: 'documents', documents: [{ format: 'mdx', frontmatter: doc.frontmatter, body: doc.body, before: { frontmatter: page.frontmatter, body: page.body }, rewritten: false }] },
      audit: audit({ name: ref }),
      editUrl: pageAdminPath(ref),
    }
  }

  const c = kind
  const doc = readSnapshot(c, info.filename)
  if (!doc) return refuse('NOT_FOUND', SNAPSHOT_NOT_FOUND)
  const s = itemState(c, ref)
  const version = s?.version ?? '"0"'
  const stale = versionProblem(args.base_version, version, `The ${noun(c)}`)
  if (stale) return stale
  // As lib/mdx-admin restoreItemSnapshot writes it: the schedule is the item's, never the version's.
  const frontmatter = carryScheduleOnSave({ target: 'live', live: s?.live.frontmatter ?? null, pending: null, incoming: doc.frontmatter, now: ctx.now })
  const restored = { frontmatter, body: doc.body }
  const current = s ? { frontmatter: s.live.frontmatter, body: s.live.body } : null
  const documents: PreviewDocument[] = [
    { ref: `${c}/${ref}`, label: `${noun(c)} ${ref}`, publicUrl: `/${c}/${ref}`, format: 'mdx', before: restoreText(current), after: restoreText(restored) },
  ]
  if (s?.pending) {
    documents.push({ ref: `${c}/${ref}#pending`, label: `Unpublished changes of ${noun(c)} ${ref} (kept in the history)`, publicUrl: null, format: 'mdx', before: restoreText(s.pending), after: restoreText(restored) })
  }
  if (documents.every((d) => d.before === d.after) && canonicalJson(current) === canonicalJson(restored) && !s?.pending) return refuse('NO_VISIBLE_CHANGE', `That version is the ${noun(c)} as it is now.`)
  return {
    ...base,
    kind: 'item.restore',
    risk: 'destructive',
    target: { kind: c, ref },
    baseVersion: version,
    args: { collection: c, ref, filename: info.filename, base_version: version },
    before: itemBefore(c, ref),
    preview: {
      kind: 'item.restore',
      risk: 'destructive',
      title: `Restore ${noun(c)} ${ref} from ${info.filename}`,
      documents,
      effects: { publicPaths: itemPublicPaths(c, ref), schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    check: { kind: 'documents', documents: [{ format: 'mdx', frontmatter: restored.frontmatter, body: restored.body, before: current, rewritten: false }] },
    audit: audit({ slug: ref }),
    editUrl: itemEditUrl(c, ref),
  }
}
