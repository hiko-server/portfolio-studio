import { internalTarget } from '../../components/Admin/shell/publishChecks'
import { safeHref } from '../url'
import { publicIssues, type Analysis, type InternalIssue, type Place } from '../contentHealth/analyze'
import { analysisOf } from '../contentHealth/collect'
import { countIssues, isHealthCheck, type HealthCheck, type HealthCounts, type HealthIssue, type HealthItem, type Severity } from '../contentHealth/types'
import { publishedCaseStudySlugs } from '../cvdata'
import type { HomeData } from '../home'
import { SITE_HOST } from '../schema'
import { aiCvViewOf, aiHomeViewOf } from './views'

/**
 * The content health report as the AI tools may see it (SERVER-ONLY,
 * design §4.2 get_content_health, §5.7; THREATS H4).
 *
 * lib/contentHealth analyses the full home and CV — hidden photos aside, it
 * reads socials.whatsapp, links limited to the PDF and the downloads, fields
 * a CV entry hides from the website, highlights visitors never see — so its
 * report can name what the AI views leave out. This view keeps:
 *
 *   - every issue of a published post, case study or page: those documents
 *     are public as a whole;
 *   - a home or CV issue only when the place it stands at is shown in the AI
 *     view of that document (lib/ai/views) and its URL is there, and never
 *     one without a URL. The same address in a hidden place is a second
 *     issue the AI never sees, so neither a fix of the hidden place nor the
 *     fact that one exists reaches it. Its `where` (which can quote an
 *     entry's title even when that field is hidden) becomes the document's
 *     name.
 *
 * A place is shown when blanking its text changes the AI view of the
 * document: a hidden field is blanked by the view anyway; a hidden or
 * PDF-only entry, a switched-off section, a hidden photo, an incomplete or
 * over-the-cap highlight, a contact field are not in it. The view's own
 * rules decide (lib/cvVisibility, lib/homeShape publicHome, the AI strips);
 * none of them is restated here.
 *
 * Ids and versions stay exactly as the report has them, so a later fix
 * proposal names what the server recomputes. A moved link's new address is
 * removed — a remote server controls it — and so is the link checker's
 * state (its counts cover hidden links too); the counts are recomputed from
 * what is kept.
 *
 * Without draft access (`drafts: false`) a link to a draft must read
 * exactly like a link to a page that does not exist, as get_content
 * answers both alike: the analyzer tells them apart (an error that "goes
 * nowhere", a warning about a draft), so at that scope both become one
 * issue — what a visitor meets, a page that cannot be opened — with the
 * same id, place and severity, and the list is sorted again the analyzer's
 * way.
 */

export type AiHealthIssue = Omit<HealthIssue, 'fix'> & { fix?: { type: string } }

export type AiHealthView = {
  generated_at: number
  counts: HealthCounts
  items: Record<string, Pick<HealthItem, 'key' | 'kind' | 'title' | 'version'> & { public_url: string; edit_url: string }>
  issues: AiHealthIssue[]
}

/** Every string inside `value`, and its link reading (lib/url safeHref), as the report spells URLs. */
function urlSetOf(...values: unknown[]): Set<string> {
  const out = new Set<string>()
  const visit = (v: unknown, depth: number) => {
    if (depth > 32) return
    if (typeof v === 'string') {
      out.add(v)
      out.add(v.trim())
      const href = safeHref(v)
      if (href) out.add(href)
    } else if (Array.isArray(v)) for (const x of v) visit(x, depth + 1)
    else if (v && typeof v === 'object') for (const x of Object.values(v)) visit(x, depth + 1)
  }
  for (const v of values) visit(v, 0)
  return out
}

/**
 * Which stored places of `doc` the view shows: a place is shown when blanking
 * its text changes the view. Works on one copy of the document (each probe
 * puts the text back) and answers each place once.
 */
function shownPlaces(doc: unknown, view: (doc: unknown) => unknown): (place: Place | undefined) => boolean {
  if (!doc || typeof doc !== 'object') return () => false
  const copy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
  const text = () => JSON.stringify(view(copy) ?? null)
  const base = text()
  const known = new Map<string, boolean>()
  return (place) => {
    if (!place || place.at !== 'field' || place.path.length === 0) return false
    const key = JSON.stringify(place.path)
    const seen = known.get(key)
    if (seen !== undefined) return seen
    let parent: any = copy
    for (const seg of place.path.slice(0, -1)) parent = parent && typeof parent === 'object' ? parent[seg as any] : undefined
    const last = place.path[place.path.length - 1]
    let shown = false
    if (parent && typeof parent === 'object' && parent[last as any] === place.value) {
      parent[last as any] = ''
      try {
        shown = text() !== base
      } finally {
        parent[last as any] = place.value
      }
    }
    known.set(key, shown)
    return shown
  }
}

const MOVED_DETAIL = 'It redirects to another address. Linking there directly skips the detour; the owner can check the new address in Content health.'

const UNOPENABLE_DETAIL = 'Visitors get the 404 page at that address. Fix the address or remove the link.'

/** A link to /blog/… or /work/… that visitors cannot open, whatever the reason: the same issue for a draft and a missing page. */
function unopenable(issue: AiHealthIssue): AiHealthIssue {
  const target = issue.url ? internalTarget(issue.url, SITE_HOST) : null
  const path = target ? `/${target.collection}/${target.slug}` : (issue.url ?? '')
  return { ...issue, severity: 'error', message: `Link to ${path} leads to a page visitors cannot open`, detail: UNOPENABLE_DETAIL }
}

/** The analyzer's order (lib/contentHealth/analyze finish): severity, item, line, message. */
const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, notice: 2 }
const byReportOrder = (a: AiHealthIssue, b: AiHealthIssue) =>
  SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.item.localeCompare(b.item) || (a.line ?? 0) - (b.line ?? 0) || a.message.localeCompare(b.message)

/** An issue as the AI reads it: no apply spec, no place, the fix by its type only. */
function aiIssue(issue: InternalIssue): AiHealthIssue {
  const { fix, ...rest } = publicIssues([issue])[0]
  return fix ? { ...rest, fix: { type: fix.type } } : rest
}

export type AiHealthAnalysis = {
  view: AiHealthView
  /** The server's own issues behind the view (apply specs and places), by id: only those the view keeps. */
  kept: ReadonlyMap<string, InternalIssue>
  items: Analysis['items']
}

/**
 * The filtered report, every issue (or one check's), with the server's
 * issues behind it — what a content-fix plan names. `drafts` says whether
 * the caller may know drafts exist (content:draft); without it, links to
 * drafts read like links to missing pages.
 */
export function aiHealthAnalysis(now = Date.now(), check?: HealthCheck, opts: { drafts: boolean } = { drafts: false }): AiHealthAnalysis {
  const { input, analysis } = analysisOf(now)
  const homeDoc = input.home?.doc ?? null
  const cvDoc = input.cv?.doc ?? null
  const home = aiHomeViewOf(homeDoc as HomeData | null)
  const published = publishedCaseStudySlugs()
  const cv = cvDoc ? aiCvViewOf(cvDoc, published) : { en: [], zh: [] }
  const urls: Record<'home' | 'cv', Set<string>> = { home: urlSetOf(home), cv: urlSetOf(cv.en, cv.zh) }
  const shown: Record<'home' | 'cv', (place: Place | undefined) => boolean> = {
    home: shownPlaces(homeDoc, (d) => aiHomeViewOf(d as HomeData)),
    cv: shownPlaces(cvDoc, (d) => aiCvViewOf(d as { en?: unknown; zh?: unknown }, published)),
  }
  const isDoc = (item: string) => /^(blog|work|page)\//.test(item)

  const issues: AiHealthIssue[] = []
  const kept = new Map<string, InternalIssue>()
  for (const issue of analysis.issues) {
    if (check && issue.check !== check) continue
    let out: AiHealthIssue
    if (isDoc(issue.item)) out = aiIssue(issue)
    else if ((issue.item === 'home' || issue.item === 'cv') && issue.url && urls[issue.item].has(issue.url) && shown[issue.item](issue.place)) {
      out = { ...aiIssue(issue), where: issue.item === 'home' ? 'Home page' : 'CV' }
    } else continue
    if (out.check === 'redirect') out.detail = MOVED_DETAIL
    issues.push(!opts.drafts && out.check === 'internal-link' ? unopenable(out) : out)
    kept.set(issue.id, issue)
  }
  if (!opts.drafts) issues.sort(byReportOrder)

  const items: AiHealthView['items'] = {}
  for (const issue of issues) {
    const it = analysis.items[issue.item]
    if (it && !items[it.key]) items[it.key] = { key: it.key, kind: it.kind, title: it.title, version: it.version, public_url: it.publicHref, edit_url: it.editHref }
  }
  return { view: { generated_at: now, counts: countIssues(issues as HealthIssue[]), items, issues }, kept, items: analysis.items }
}

/** The filtered report, every issue (or one check's); see aiHealthAnalysis. */
export function aiHealthView(now = Date.now(), check?: HealthCheck, opts: { drafts: boolean } = { drafts: false }): AiHealthView {
  return aiHealthAnalysis(now, check, opts).view
}

export { isHealthCheck }
