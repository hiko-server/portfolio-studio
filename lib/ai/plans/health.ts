import { documentText } from '../../../components/Admin/shell/textDiff'
import type { ApplySpec } from '../../contentHealth/analyze'
import { applyToContent, clone } from '../../contentHealth/applyPure'
import { buildAnalysis } from '../../contentHealth/collect'
import { readCvDataWithVersion, type FullCvDoc } from '../../cvdata'
import { publicHome, readHomeWithVersion } from '../../home'
import { isPageName, readOne, readPage } from '../../mdx-admin'
import type { ToolContext, ToolRefusal } from '../toolTypes'
import { aiHealthView } from '../healthView'
import { itemBefore, needsDraftAccess, prettyJson, refuse, stringLeaves } from './common'
import { cvLinks, cvPublicView } from './cv'
import { homeLinks } from './home'
import type { BeforeState, CheckedDocument, PreviewDocument, WritePlan } from './types'

/**
 * Plan of `propose_content_fix` (pure, design §4.2): apply the automatic
 * fixes of content health issues — strip tracking parameters, point a moved
 * link at its new address, turn line breaks into paragraphs, import a
 * remote image into the uploads — through the same save path as the
 * Content health page, once the owner approves.
 *
 *   - Only ids of the AI's filtered report (lib/ai/healthView) can be named,
 *     with the item version that report showed.
 *   - Each document is computed with the pure applyToContent
 *     (lib/contentHealth/applyPure), the function the writer runs.
 *   - A moved link's new address was chosen by a remote server: it is
 *     stored in the arguments and listed as a new link; at approval a
 *     different address is a conflict. An image import stores its source
 *     address; the file itself is not seen until it arrives, so the
 *     document shows where the imported copy goes (`/uploads/imported-from-
 *     <host>`, named at import) and the card says so (effects.import). One
 *     image import per proposal.
 *   - "Generate sizes" changes no document and is not offered: the owner
 *     runs it in Content health.
 */

export type ContentFixArgs = { fixes: Array<{ id: string; version: number; to?: string; url?: string }>; rationale?: string }

export const MAX_FIXES = 100

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Where an imported copy is shown in the preview (the stored name is chosen when the file arrives). */
export const importedPlaceholder = (url: string) => `/uploads/imported-from-${hostOf(url) || 'remote'}`

type Work = { id: string; spec: Exclude<ApplySpec, { op: 'generate-variants' }>; item: string }

export function planContentFix(args: ContentFixArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  if (!args.fixes.length || args.fixes.length > MAX_FIXES) return refuse('INVALID_INPUT', `fixes: 1 to ${MAX_FIXES} issues.`, { field: 'fixes' })
  const view = aiHealthView(ctx.now, undefined, { drafts: ctx.scopes.has('content:draft') })
  const visible = new Set(view.issues.map((i) => i.id))
  const analysis = buildAnalysis(ctx.now)
  const byId = new Map(analysis.issues.map((i) => [i.id, i]))

  const work: Work[] = []
  const fixes: ContentFixArgs['fixes'] = []
  const imports = new Set<string>()
  const seen = new Set<string>()
  for (const [i, fix] of args.fixes.entries()) {
    const field = `fixes[${i}]`
    if (seen.has(fix.id)) continue
    seen.add(fix.id)
    const issue = byId.get(fix.id)
    if (!issue || !visible.has(fix.id)) return refuse('NOT_FOUND', `${field}: no such issue in the content health report now (read it again with get_content_health).`, { field })
    const spec = issue.apply
    if (!spec) return refuse('INVALID_INPUT', `${field}: this issue has no automatic fix; the owner fixes it in the editor.`, { field })
    if (spec.op === 'generate-variants') return refuse('INVALID_INPUT', `${field}: generating image sizes changes no document; the owner runs it in Content health.`, { field })
    const item = analysis.items[issue.item]
    if (!item || item.version !== fix.version) return refuse('VERSION_CONFLICT', `${field}: the item changed since the report was read: read it again.`, { field, current_version: item?.version ?? null })
    const to = spec.op === 'use-new-url' ? spec.to : undefined
    const url = spec.op === 'import-image' ? spec.url : undefined
    if ((fix.to !== undefined && fix.to !== to) || (fix.url !== undefined && fix.url !== url)) {
      return refuse('VERSION_CONFLICT', `${field}: the fix changed since it was proposed (a new address or a different image).`, { field })
    }
    if (url !== undefined) imports.add(url)
    work.push({ id: fix.id, spec, item: issue.item })
    fixes.push({ id: fix.id, version: fix.version, ...(to !== undefined ? { to } : {}), ...(url !== undefined ? { url } : {}) })
  }
  if (imports.size > 1) return refuse('INVALID_INPUT', 'fixes: one image import per proposal. Propose the others separately.', { field: 'fixes' })
  const imported = new Map(Array.from(imports, (u) => [u, importedPlaceholder(u)]))

  const groups = new Map<string, Work[]>()
  for (const w of work) groups.set(w.item, [...(groups.get(w.item) ?? []), w])
  const documents: PreviewDocument[] = []
  const checked: CheckedDocument[] = []
  const before: BeforeState[] = []
  const paths = new Set<string>()
  for (const [key, list] of groups) {
    const item = analysis.items[key]
    if (item.kind === 'post' || item.kind === 'work' || item.kind === 'page') {
      const name = key.slice(key.indexOf('/') + 1)
      const c = item.kind === 'post' ? 'blog' : item.kind === 'work' ? 'work' : null
      const current = c ? readOne(c, name) : isPageName(name) ? readPage(name) : null
      if (!current) return refuse('NOT_FOUND', `${key} no longer exists.`)
      const state = { body: current.body, doc: clone(current.frontmatter || {}) as Record<string, any> }
      let changed = 0
      for (const w of list) if (applyToContent(w.spec, state, imported)) changed++
      if (!changed) continue
      documents.push({ ref: key, label: `${item.kind === 'page' ? 'Page' : item.kind === 'post' ? 'Post' : 'Case study'} ${name}`, publicUrl: item.publicHref, format: 'mdx', before: documentText(current.frontmatter, current.body), after: documentText(state.doc, state.body) })
      checked.push({ format: 'mdx', frontmatter: state.doc, body: state.body, before: { frontmatter: current.frontmatter, body: current.body }, rewritten: true })
      before.push(c ? itemBefore(c, name) : { kind: 'page', name, page: { frontmatter: current.frontmatter, body: current.body, updatedAt: (current as { updatedAt: number }).updatedAt } })
      paths.add(item.publicHref)
      continue
    }
    if (item.kind === 'cv') {
      const read = readCvDataWithVersion()
      const doc = clone({ en: read.en, zh: read.zh }) as FullCvDoc
      const state = { body: '', doc: doc as unknown as Record<string, any> }
      let changed = 0
      for (const w of list) if (applyToContent(w.spec, state, imported)) changed++
      if (!changed) continue
      const stored = { en: read.en, zh: read.zh }
      const vb = cvPublicView(stored)
      const va = cvPublicView(doc)
      documents.push({ ref: 'cv', label: 'CV as visitors see it', publicUrl: '/cv', format: 'json', before: prettyJson(vb), after: prettyJson(va) })
      checked.push({ format: 'json', strings: stringLeaves(doc), beforeStrings: stringLeaves(stored), links: cvLinks(va), beforeLinks: cvLinks(vb), images: [], beforeImages: [], rewritten: true })
      before.push({ kind: 'doc', doc: 'cv', value: stored, version: read.version })
      paths.add('/cv')
      continue
    }
    const { home, version } = readHomeWithVersion()
    if (!home) return refuse('NOT_FOUND', 'The home page no longer exists.')
    const doc = clone(home) as unknown as Record<string, any>
    const state = { body: '', doc }
    let changed = 0
    for (const w of list) if (applyToContent(w.spec, state, imported)) changed++
    if (!changed) continue
    const vb = publicHome(home)
    const va = publicHome(doc as never)
    documents.push({ ref: 'home', label: 'Home page as visitors see it', publicUrl: '/', format: 'json', before: prettyJson(vb), after: prettyJson(va) })
    checked.push({ format: 'json', strings: stringLeaves(doc), beforeStrings: stringLeaves(home), links: homeLinks(va), beforeLinks: homeLinks(vb), images: [], beforeImages: [], rewritten: true })
    before.push({ kind: 'doc', doc: 'home', value: home, version })
    paths.add('/')
  }
  if (!documents.length) return refuse('NO_VISIBLE_CHANGE', 'Those problems are already fixed: nothing would change.')
  const importUrl = Array.from(imports)[0]
  const n = fixes.length
  return {
    kind: 'health.fix',
    risk: 'live',
    proposal: true,
    target: { kind: 'health', ref: 'content' },
    baseVersion: null,
    args: { fixes },
    rationale: args.rationale ?? null,
    before: { kind: 'documents', documents: before },
    preview: {
      kind: 'health.fix',
      risk: 'live',
      title: `Apply ${n} content health ${n === 1 ? 'fix' : 'fixes'}`,
      documents,
      effects: { publicPaths: Array.from(paths), schedule: null, deleted: false, import: importUrl ? { url: importUrl, host: hostOf(importUrl) } : null, hiddenValuesChanged: null },
    },
    held: null,
    check: { kind: 'documents', documents: checked },
    audit: { route: 'admin/content-health', method: 'POST', body: { action: 'fix', fixes } },
    editUrl: '/admin/system?view=content',
  }
}
