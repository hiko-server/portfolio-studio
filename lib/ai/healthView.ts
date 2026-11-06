import { internalTarget } from '../../components/Admin/shell/publishChecks'
import { safeHref } from '../url'
import { buildReport } from '../contentHealth/collect'
import { countIssues, isHealthCheck, type HealthCheck, type HealthCounts, type HealthIssue, type HealthItem, type Severity } from '../contentHealth/types'
import { SITE_HOST } from '../schema'
import { aiCvView, aiHomeView } from './views'

/**
 * The content health report as the AI tools may see it (SERVER-ONLY,
 * design §4.2 get_content_health; THREATS H4).
 *
 * lib/contentHealth analyses the full home and CV — hidden photos aside, it
 * reads socials.whatsapp, links limited to the PDF and the downloads, fields
 * a CV entry hides from the website — so its report can name what the AI
 * views leave out. This view keeps:
 *
 *   - every issue of a published post, case study or page: those documents
 *     are public as a whole;
 *   - a home or CV issue only when its URL appears in the AI view of that
 *     document (lib/ai/views), and never one without a URL. Its `where`
 *     (which can quote an entry's title even when that field is hidden)
 *     becomes the document's name.
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

/**
 * The filtered report, every issue (or one check's). `drafts` says whether
 * the caller may know drafts exist (content:draft); without it, links to
 * drafts read like links to missing pages.
 */
export function aiHealthView(now = Date.now(), check?: HealthCheck, opts: { drafts: boolean } = { drafts: false }): AiHealthView {
  const report = buildReport(now)
  const home = aiHomeView().home
  const cv = aiCvView()
  const views: Record<'home' | 'cv', Set<string>> = { home: urlSetOf(home), cv: urlSetOf(cv.en, cv.zh) }
  const isDoc = (item: string) => /^(blog|work|page)\//.test(item)

  const issues: AiHealthIssue[] = []
  for (const issue of report.issues) {
    if (check && issue.check !== check) continue
    let kept: AiHealthIssue
    if (isDoc(issue.item)) kept = { ...issue }
    else if ((issue.item === 'home' || issue.item === 'cv') && issue.url && views[issue.item].has(issue.url)) {
      kept = { ...issue, where: issue.item === 'home' ? 'Home page' : 'CV' }
    } else continue
    if (kept.check === 'redirect') kept.detail = MOVED_DETAIL
    if (issue.fix) kept.fix = { type: issue.fix.type }
    else delete kept.fix
    issues.push(!opts.drafts && kept.check === 'internal-link' ? unopenable(kept) : kept)
  }
  if (!opts.drafts) issues.sort(byReportOrder)

  const items: AiHealthView['items'] = {}
  for (const issue of issues) {
    const it = report.items[issue.item]
    if (it && !items[it.key]) items[it.key] = { key: it.key, kind: it.kind, title: it.title, version: it.version, public_url: it.publicHref, edit_url: it.editHref }
  }
  return { generated_at: report.generatedAt, counts: countIssues(issues as HealthIssue[]), items, issues }
}

export { isHealthCheck }
