import { diffJson, type DiffEntry } from '../shell/jsonDiff'
import { isPageName, pageAdminPath } from '../../../lib/pageNames'
import { diffLines, type DiffLine } from '../shell/textDiff'
import { CHANGES_COPY, CHANGE_KIND_COPY } from './copy'
import type { ChangeActor, ChangeDetail, ChangePreview, ChangeState, PreviewDocument, PublishCheckNote } from './types'

/**
 * Pure helpers of the AI change card (design §8.2), unit tested in
 * tests/ai-change-ui: the diff model the card and the review sheet share,
 * the truncation that keeps Approve off until a long change was read to its
 * end, and the server-computed facts in words. Nothing here reads model text
 * except the rationale, which the card only ever quotes.
 */

/** Changed lines the card shows before it asks for Review all (§5.3). */
export const CARD_CHANGED_LIMIT = 12
/** A JSON value longer than this is shortened on the card (never in the sheet), which makes the card truncated. */
export const CARD_VALUE_CHARS = 280

export type DocDiff =
  | { format: 'mdx'; doc: PreviewDocument; lines: DiffLine[]; changed: number }
  | { format: 'json'; doc: PreviewDocument; entries: DiffEntry[]; changed: number }

export type ChangeDiff = {
  docs: DocDiff[]
  /** Changed lines (MDX) and changed values (JSON) over every document. */
  changed: number
  unit: 'lines' | 'values' | 'changes'
}

const splitLines = (s: string): string[] => {
  if (!s) return []
  const lines = s.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * A complete line diff of two texts. Inputs too long for the browser's LCS
 * table still come back whole: the common start and end as unchanged lines,
 * everything between as removed then added — so nothing is ever left out.
 */
export function fullLineDiff(before: string, after: string): DiffLine[] {
  const d = diffLines(before, after)
  if (!d.tooLarge) return d.lines
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const lines: DiffLine[] = []
  for (let i = 0; i < start; i++) lines.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 })
  for (let i = start; i < endA; i++) lines.push({ kind: 'del', text: a[i], oldNo: i + 1 })
  for (let j = start; j < endB; j++) lines.push({ kind: 'add', text: b[j], newNo: j + 1 })
  for (let k = 0; k < a.length - endA; k++) lines.push({ kind: 'same', text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 })
  return lines
}

/** A JSON document's text, parsed (an empty text is "nothing": a removed document). */
function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Every difference of one preview document, in full. */
export function docDiff(doc: PreviewDocument): DocDiff {
  if (doc.format === 'json') {
    const before = parseJson(doc.before)
    const after = parseJson(doc.after)
    // A document that appears or disappears entirely is one value; else every changed value, none left out.
    const entries: DiffEntry[] =
      before === undefined && after !== undefined
        ? [{ path: '(whole)', kind: 'added', after }]
        : after === undefined && before !== undefined
          ? [{ path: '(whole)', kind: 'removed', before }]
          : diffJson(before, after, Number.MAX_SAFE_INTEGER).entries
    return { format: 'json', doc, entries, changed: entries.length }
  }
  const lines = fullLineDiff(doc.before, doc.after)
  return { format: 'mdx', doc, lines, changed: lines.filter((l) => l.kind !== 'same').length }
}

/** The diff of a whole preview: every document, and the count of what changed. */
export function changeDiff(preview: Pick<ChangePreview, 'documents'>): ChangeDiff {
  const docs = preview.documents.map(docDiff)
  const formats = new Set(docs.map((d) => d.format))
  const unit = formats.size > 1 ? 'changes' : formats.has('json') ? 'values' : 'lines'
  return { docs, changed: docs.reduce((n, d) => n + d.changed, 0), unit }
}

export type CompactDoc =
  | { format: 'mdx'; doc: PreviewDocument; lines: DiffLine[] }
  | { format: 'json'; doc: PreviewDocument; entries: Array<DiffEntry & { shortened: boolean }> }

/**
 * What the card shows: the first CARD_CHANGED_LIMIT changed lines or
 * values (with the unchanged lines around them, which LineDiffView folds),
 * and whether anything is left for the sheet. `truncated` is what keeps
 * Approve off until the whole change has been read (§5.3: harmful text
 * can't sit on line 13). A value the card shortens counts as truncated too.
 */
export function compactDiff(diff: ChangeDiff, limit = CARD_CHANGED_LIMIT): { docs: CompactDoc[]; shown: number; truncated: boolean } {
  const docs: CompactDoc[] = []
  let shown = 0
  let shortened = false
  for (const d of diff.docs) {
    if (shown >= limit) break
    if (d.format === 'mdx') {
      const lines: DiffLine[] = []
      for (const l of d.lines) {
        if (l.kind !== 'same') {
          if (shown >= limit) break
          shown++
        }
        lines.push(l)
      }
      docs.push({ format: 'mdx', doc: d.doc, lines })
    } else {
      const entries: Array<DiffEntry & { shortened: boolean }> = []
      for (const e of d.entries) {
        if (shown >= limit) break
        shown++
        const long = valueText(e.before).length > CARD_VALUE_CHARS || valueText(e.after).length > CARD_VALUE_CHARS
        if (long) shortened = true
        entries.push({ ...e, shortened: long })
      }
      docs.push({ format: 'json', doc: d.doc, entries })
    }
  }
  return { docs, shown, truncated: shown < diff.changed || shortened }
}

/** A JSON value as text: strings as they are, anything else as indented JSON ("" for nothing). */
export function valueText(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * A moment stored as milliseconds (an `…At` key holding a number of this
 * century), in words beside the number — the number itself is what is
 * written, so it stays.
 */
export function momentOf(path: string, v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 946_684_800_000 || v > 4_102_444_800_000) return null
  if (!/(?:^|\.|\])[A-Za-z]*At$/.test(path)) return null
  return formatMoment(new Date(v).toISOString())
}

/** A value shortened for the card (the sheet always shows it whole). */
export function shortText(text: string, max = CARD_VALUE_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The Approve button's words and the done line's verb for a kind (never a bare "Approve"). */
export function kindCopy(kind: string) {
  return CHANGE_KIND_COPY[kind] ?? { approve: 'Approve & apply', done: 'Applied' }
}

/** Who proposed a change, as the owner named it (a connected app's label) or the assistant with its provider. */
export function actorText(actor: Pick<ChangeActor, 'kind' | 'label' | 'provider'>): string {
  return actor.kind === 'assistant' ? CHANGES_COPY.actorAssistant(actor.provider) : actor.label
}

/**
 * The server's title split around the part to set in mono — a post's,
 * case study's or image's own name, or a page's address ("/now") — so a
 * slug reads as a slug. The title itself is composed by the server from
 * the action and the target, never by a model. The home page, the CV, tags
 * and content health have no such name.
 */
export function titleParts(title: string, target: { kind: string; ref: string }): [string, string, string] {
  const mono = target.kind === 'blog' || target.kind === 'work' || target.kind === 'media' ? target.ref : target.kind === 'page' ? `/${target.ref}` : ''
  const at = mono ? title.lastIndexOf(mono) : -1
  if (at < 0) return [title, '', '']
  return [title.slice(0, at), mono, title.slice(at + mono.length)]
}

/**
 * How the done line and the undo toast name what a change acted on, the way
 * the headline and the effect line do: a post's, case study's or image's
 * own name and a page's address ("/now") in mono, the home page and the CV
 * in words. Null when the target is no single thing to name (tags across a
 * collection, content health) or is not what changed (an import's target is
 * the host it copies from): the verb stands alone, under a row or headline
 * that already says what it was.
 */
export function targetName(c: { kind: string; target: { kind: string; ref: string } }): { text: string; mono: boolean } | null {
  const { kind, ref } = c.target
  if (c.kind === 'media.import' || !ref) return null
  if (kind === 'blog' || kind === 'work' || kind === 'media') return { text: ref, mono: true }
  if (kind === 'page') return { text: `/${ref}`, mono: true }
  if (kind === 'home') return { text: CHANGES_COPY.homePage, mono: false }
  if (kind === 'cv') return { text: CHANGES_COPY.cvPage, mono: false }
  return null
}

/** The one sentence under the headline: what the change does on the site, from the preview's effects. */
export function effectLine(preview: ChangePreview): string {
  const e = CHANGES_COPY.effect
  const doc = preview.documents[0]
  const url = doc?.publicUrl ?? preview.effects.publicPaths[0] ?? ''
  const others = preview.effects.publicPaths.filter((p) => p !== url).length
  const n = preview.documents.length
  switch (preview.kind) {
    case 'item.publish':
      return e.goesLive(url, others)
    case 'item.unpublish':
      return e.comesOff(url)
    case 'item.schedule':
      return e.schedule
    case 'item.unschedule':
      return e.unschedule
    case 'item.discard-changes':
      return e.discard
    case 'page.edit':
      return e.changesNow(url, others)
    case 'home.edit':
      return e.changesNow(CHANGES_COPY.homePage, others)
    case 'cv.edit':
      return e.changesNow(CHANGES_COPY.cvPage, others)
    case 'item.restore':
    case 'page.restore':
      return e.replaces(url)
    case 'home.restore':
      return e.replaces(CHANGES_COPY.homePage)
    case 'cv.restore':
      return e.replaces(CHANGES_COPY.cvPage)
    case 'tag.change':
      return e.tags(n)
    case 'health.fix':
      return e.health(n)
    case 'media.apply-alt':
      return e.alt(n)
    case 'media.import':
      return e.import(preview.effects.import?.host ?? '')
    case 'item.delete':
      return preview.effects.publicPaths.length ? e.deleteLive(url) : e.deleteDraft
    case 'media.trash':
      return e.trash(doc?.ref.replace(/^media\//, '') ?? '')
    case 'item.edit-held':
      return e.held
    case 'item.create':
    case 'item.edit-draft':
      return e.draft
    case 'item.edit-pending':
      return e.pending
    case 'media.texts':
      return e.texts
    case 'item.editor':
    case 'page.editor':
      return e.editor
    default:
      return ''
  }
}

/**
 * Kinds whose approval changes what visitors see at once: their undo line adds what an undo can't take back. A
 * delete does so only when the item is on the site (its preview names public pages); deleting a draft reaches
 * no reader, as its effect line says.
 */
const PUBLIC_AT_APPROVAL = new Set(['item.publish', 'item.unpublish', 'item.restore', 'page.edit', 'page.restore', 'home.edit', 'home.restore', 'cv.edit', 'cv.restore', 'tag.change', 'health.fix', 'media.apply-alt'])
const PUBLIC_WHEN_LIVE = new Set(['item.delete'])
/** Kinds with no one-click undo (lib/ai/apply UNDO_KINDS is the rest). */
const MULTI_DOCUMENT = new Set(['tag.change', 'health.fix', 'media.apply-alt'])

/**
 * The undo line every waiting card shows before the click (§8.2): honest about what an undo can't reach. `fetched`
 * (readers, feeds and crawlers may already hold it) only when the change goes live.
 */
export function undoLines(kind: string, preview: Pick<ChangePreview, 'effects'> | null): { line: string; fetched: boolean; multi: boolean } {
  const u = CHANGES_COPY.undoLine
  const multi = MULTI_DOCUMENT.has(kind)
  const line = multi ? u.multi : kind === 'media.trash' ? u.trash : kind === 'media.import' ? u.import : u.one
  const fetched = PUBLIC_AT_APPROVAL.has(kind) || (PUBLIC_WHEN_LIVE.has(kind) && !!preview && preview.effects.publicPaths.length > 0)
  return { line, fetched, multi }
}

/**
 * The publish checks that stop a publish: the `error` ones, exactly as the editor's PublishSheet refuses to publish
 * while canPublish (components/Admin/shell/publishChecks) finds one. A check the card marks blocking blocks Approve.
 */
export function blockingChecks(checks: ReadonlyArray<PublishCheckNote> | null | undefined): PublishCheckNote[] {
  return (checks ?? []).filter((c) => c.level === 'error')
}

/** Why the card's Approve is off now, in the order the card explains it; null when it can be pressed. */
export type ApproveBlock = 'decided' | 'checks' | 'unread' | 'busy' | 'unarmed'

export function approveBlock(s: { waiting: boolean; preview: boolean; blocking: number; needsRead: boolean; busy: boolean; armed: boolean }): ApproveBlock | null {
  if (!s.waiting || !s.preview) return 'decided'
  // Reading to the end or arming can't make a blocked publish approvable: say what blocks it.
  if (s.blocking > 0) return 'checks'
  if (s.needsRead) return 'unread'
  if (s.busy) return 'busy'
  if (!s.armed) return 'unarmed'
  return null
}

type ScheduleShape = { before?: { publish_at?: unknown; unpublish_at?: unknown }; after?: { publish_at?: unknown; unpublish_at?: unknown } }
type HeldShape = { held: 'scheduled'; publish_at: string } | { held: 'review_link'; active_links: number }

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)

/** The held reason of an edit to an item that would reach someone without approval (§4.6), from the preview. */
export function heldOf(preview: ChangePreview): HeldShape | null {
  const s = preview.effects.schedule as Record<string, unknown> | null
  if (!s || typeof s !== 'object') return null
  if (s.held === 'scheduled' && isoOrNull(s.publish_at)) return { held: 'scheduled', publish_at: s.publish_at as string }
  if (s.held === 'review_link' && typeof s.active_links === 'number') return { held: 'review_link', active_links: s.active_links }
  return null
}

/** The schedule a change sets, when it sets or clears one: the times after it, ISO. */
export function scheduleOf(preview: ChangePreview): { publishAt: string | null; unpublishAt: string | null; cleared: boolean } | null {
  if (heldOf(preview)) return null
  const s = preview.effects.schedule as ScheduleShape | null
  if (!s || typeof s !== 'object' || !s.after) return null
  const publishAt = isoOrNull(s.after.publish_at)
  const unpublishAt = isoOrNull(s.after.unpublish_at)
  const before = s.before ?? {}
  const changed = publishAt !== isoOrNull(before.publish_at) || unpublishAt !== isoOrNull(before.unpublish_at)
  if (!changed) return null
  return { publishAt, unpublishAt, cleared: !publishAt && !unpublishAt }
}

/** A moment as the admin writes it: "7 Nov 2026, 14:05" in this browser's time zone. */
export function formatMoment(iso: string, locale?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The one-line summary of a decided change (Changes rows and the card's done line). */
export function decidedLine(c: Pick<ChangeDetail, 'state' | 'kind' | 'code'>): string {
  const st = CHANGES_COPY.state
  switch (c.state as ChangeState) {
    case 'applying':
      return st.applying
    case 'conflict':
      return st.conflict
    case 'expired':
      return st.expired
    case 'voided':
      return st.voided(c.code)
    case 'failed':
      return st.failed(c.code)
    case 'rejected':
      return st.rejected
    case 'undone':
      return st.undone
    case 'in_editor':
      return st.inEditor
    default:
      return ''
  }
}

/** Where "Open history" goes for a target: its editor (which holds its history), or Versions for the home page and CV. */
export function historyHref(c: Pick<ChangeDetail, 'target' | 'result'>): string | null {
  if (c.target.kind === 'home' || c.target.kind === 'cv') return '/admin/dashboard?tab=versions'
  const href = c.result?.editUrl
  return typeof href === 'string' && href.startsWith('/admin/') ? href : null
}

/** The public pages an approval changed at once (get_change's public_urls), for "Live now:". */
export function livePaths(c: Pick<ChangeDetail, 'result'>): string[] {
  const r = c.result
  if (!r || !Array.isArray(r.publicUrls)) return []
  return r.publicUrls.filter((p) => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//')).slice(0, 12)
}

/**
 * Where each document of a change keeps its own history (the editor that
 * holds it, Versions for the home page and the CV, the media drawer): the
 * links a multi-document change lists beside "No single undo" (§8.2). One
 * per place, in the preview's order; only admin pages.
 */
export function historyLinks(preview: Pick<ChangePreview, 'documents'>): Array<{ label: string; href: string }> {
  const out: Array<{ label: string; href: string }> = []
  const seen = new Set<string>()
  for (const d of preview.documents) {
    const ref = d.ref.replace(/#.*$/, '')
    const [kind, ...rest] = ref.split('/')
    const name = rest.join('/')
    const href =
      (kind === 'blog' || kind === 'work') && name
        ? `/admin/${kind}/edit?slug=${encodeURIComponent(name)}`
        : kind === 'page' && isPageName(name)
          ? pageAdminPath(name)
          : ref === 'home' || ref === 'cv'
            ? '/admin/dashboard?tab=versions'
            : kind === 'media' && name
              ? `/admin/media?open=${encodeURIComponent(name)}`
              : null
    if (!href || seen.has(href)) continue
    seen.add(href)
    out.push({ label: ref === 'home' ? 'Home page' : ref === 'cv' ? 'CV' : ref, href })
  }
  return out
}
