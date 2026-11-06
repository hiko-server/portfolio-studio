import * as z from 'zod'
import { readCvDataWithVersion } from '../../cvdata'
import { CV_SECTIONS } from '../../cvSections'
import { kvEtag } from '../../contentStore'
import type { CvSectionLike } from '../../cvVisibility'
import { PAGE_BUDGET_BYTES, READ_ANNOTATIONS, RESULT_MAX_BYTES, byteLength, defineTool, ok, type ToolContext } from '../toolTypes'
import { aiCvView, aiHomeView } from '../views'

/**
 * get_home and get_cv (design §4.2): the public views only (lib/ai/views),
 * never the stored documents. With draft access the result also names the
 * document's version, which a proposal must quote as base_version.
 */

const canDraft = (ctx: ToolContext) => ctx.scopes.has('content:draft')

/** The top-level keys of the home document (lib/homeShape HomeData). */
const HOME_SECTIONS = ['hero', 'socials', 'brands', 'quickAccess', 'photos', 'highlights', 'contact', 'availability', 'openSource', 'site', 'sections', 'sectionOrder'] as const

export const getHome = defineTool({
  name: 'get_home',
  title: 'Read the home page',
  description:
    'Read the home page as visitors see it: introduction, socials, quick links, field-note photos, highlights, contact copy, ' +
    'availability, open-source picks and site name. section limits it to one part. Array positions here are the ones a home ' +
    'proposal uses. Contact details (phone, e-mail, WhatsApp) are not readable.',
  scope: 'content:read',
  cost: 'cheap',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: false, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    section: z.enum(HOME_SECTIONS).optional().describe('One part of the home document. Absent: all of it.'),
  }),
  targetOf: () => ({ kind: 'home', ref: 'home' }),
  read(args, ctx) {
    const { home, version } = aiHomeView()
    const meta = { public_url: '/', edit_url: '/admin/home', ...(canDraft(ctx) ? { version: kvEtag(version) } : {}) }
    if (!home) return ok({ home: null, ...meta })
    if (args.section) return ok({ section: args.section, value: (home as Record<string, unknown>)[args.section] ?? null, ...meta })
    const whole = { home, ...meta }
    if (byteLength(whole) <= RESULT_MAX_BYTES - 1024) return ok(whole)
    return ok({ truncated: true, sections: HOME_SECTIONS.filter((k) => (home as Record<string, unknown>)[k] !== undefined), message: 'Too long for one result: ask for one section at a time.', ...meta })
  },
})

const CV_SECTION_NAMES = CV_SECTIONS.map((s) => s.sessionName) as [string, ...string[]]

/**
 * The CV in parts that each fit one result. A section that fits a page is
 * one unit; a longer one is split by its entries (every list of the
 * section: papers, experiences, ...), each entry a unit, so every section
 * is readable however long it grows. A part of a split section carries the
 * section's other fields and, under `entries`, which entries of which list
 * it holds. An entry that alone is larger than a result is named by its
 * uid and left out, with the reason, so the paging always moves on.
 */
type CvUnit =
  | { kind: 'whole'; lang: 'en' | 'zh'; at: number; section: CvSectionLike; bytes: number }
  | { kind: 'entry'; lang: 'en' | 'zh'; at: number; header: CvSectionLike; list: string; index: number; total: number; entry: unknown; bytes: number }

const ENTRY_TOO_LARGE = 'This entry is larger than one result can hold. The owner can read it in the CV editor.'

/** A section's entry lists: its array fields, in order. */
const listKeys = (section: CvSectionLike) => Object.keys(section).filter((k) => Array.isArray(section[k]))

function headerOf(section: CvSectionLike): CvSectionLike {
  const out: CvSectionLike = {}
  for (const [k, v] of Object.entries(section)) if (!Array.isArray(v)) out[k] = v
  return out
}

function cvUnits(sections: Array<{ lang: 'en' | 'zh'; section: CvSectionLike }>): CvUnit[] {
  const units: CvUnit[] = []
  sections.forEach(({ lang, section }, at) => {
    const whole = byteLength({ lang, section }) + 1
    if (whole <= PAGE_BUDGET_BYTES) {
      units.push({ kind: 'whole', lang, at, section, bytes: whole })
      return
    }
    const header = headerOf(section)
    for (const list of listKeys(section)) {
      const entries = section[list] as unknown[]
      entries.forEach((entry, index) => {
        const bytes = byteLength(entry) + 1
        const fits = bytes + byteLength({ lang, section: header }) + 256 <= PAGE_BUDGET_BYTES
        const shown = fits ? entry : { ...(entry && typeof entry === 'object' && 'uid' in entry ? { uid: (entry as { uid?: unknown }).uid } : {}), omitted: ENTRY_TOO_LARGE }
        units.push({ kind: 'entry', lang, at, header, list, index, total: entries.length, entry: shown, bytes: fits ? bytes : byteLength(shown) + 1 })
      })
    }
  })
  return units
}

/** The parts of a run of units: a whole section is a part, and consecutive entries of one section form one. */
function cvParts(units: readonly CvUnit[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  let open: { at: number; lang: string; section: CvSectionLike; entries: Record<string, { from: number; count: number; total: number }> } | null = null
  const close = () => {
    if (open) parts.push({ lang: open.lang, section: open.section, entries: open.entries })
    open = null
  }
  for (const u of units) {
    if (u.kind === 'whole') {
      close()
      parts.push({ lang: u.lang, section: u.section })
      continue
    }
    if (!open || open.at !== u.at) {
      close()
      open = { at: u.at, lang: u.lang, section: { ...u.header }, entries: {} }
    }
    const list = (open.section[u.list] as unknown[] | undefined) ?? (open.section[u.list] = [])
    list.push(u.entry)
    const range = open.entries[u.list] ?? (open.entries[u.list] = { from: u.index, count: 0, total: u.total })
    range.count++
  }
  close()
  return parts
}

/** Units from `from` that fit one page: at least one, so the paging always moves on. */
function cvPage(units: readonly CvUnit[], from: number): { parts: Array<Record<string, unknown>>; next: number | null } {
  let end = from
  let used = 2
  let lastSection = -1
  while (end < units.length) {
    const u = units[end]
    // A new part of a split section repeats its header and says which entries it holds.
    const overhead = u.kind === 'entry' && u.at !== lastSection ? byteLength({ lang: u.lang, section: u.header }) + 256 : 0
    if (end > from && used + u.bytes + overhead > PAGE_BUDGET_BYTES) break
    used += u.bytes + overhead
    lastSection = u.kind === 'entry' ? u.at : -1
    end++
  }
  let parts = cvParts(units.slice(from, end))
  // The estimate above is an upper bound per unit; check the real size once, and shorten if ever needed.
  while (end > from + 1 && byteLength(parts) > PAGE_BUDGET_BYTES) {
    end--
    parts = cvParts(units.slice(from, end))
  }
  return { parts, next: end < units.length ? end : null }
}

export const getCv = defineTool({
  name: 'get_cv',
  title: 'Read the CV',
  description:
    'Read the CV as visitors see it on the website, in English (en), Chinese (zh) or both, whole or one section (by its sessionName). ' +
    'Entries carry their uid, which a CV proposal names. Hidden content and contact details (phone, e-mail, address) are not readable. ' +
    'A long CV comes in parts: pass next_offset back as offset (with the same lang and section). A long section is split by its entries: ' +
    'such a part holds the section\'s other fields and, under entries, which entries of which list it carries (from, count, total).',
  scope: 'content:read',
  cost: 'cheap',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: false, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    lang: z.enum(['en', 'zh']).optional().describe('en or zh. Absent: both.'),
    section: z.enum(CV_SECTION_NAMES).optional().describe('One section, by sessionName (for example experiences, education).'),
    offset: z.number().int().min(0).max(100_000).optional().describe('Where this part starts, from next_offset. Default 0.'),
  }),
  targetOf: (args) => ({ kind: 'cv', ref: args.section ?? 'cv' }),
  read(args, ctx) {
    const view = aiCvView()
    const sections = (['en', 'zh'] as const)
      .filter((lang) => !args.lang || args.lang === lang)
      .flatMap((lang) => view[lang].filter((s) => !args.section || s.sessionName === args.section).map((section) => ({ lang, section })))
    const units = cvUnits(sections)
    const from = Math.min(args.offset ?? 0, units.length)
    const { parts, next } = cvPage(units, from)
    return ok({
      sections: parts,
      offset: from,
      next_offset: next,
      truncated: next !== null,
      public_url: '/cv',
      edit_url: '/admin/dashboard?tab=cv',
      ...(canDraft(ctx) ? { version: kvEtag(readCvDataWithVersion().version) } : {}),
    })
  },
})
