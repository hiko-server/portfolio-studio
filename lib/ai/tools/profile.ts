import * as z from 'zod'
import { readCvDataWithVersion } from '../../cvdata'
import { CV_SECTIONS } from '../../cvSections'
import { kvEtag } from '../../contentStore'
import { READ_ANNOTATIONS, RESULT_MAX_BYTES, byteLength, defineTool, fitItems, ok, type ToolContext } from '../toolTypes'
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

export const getCv = defineTool({
  name: 'get_cv',
  title: 'Read the CV',
  description:
    'Read the CV as visitors see it on the website, in English (en), Chinese (zh) or both, whole or one section (by its sessionName). ' +
    'Entries carry their uid, which a CV proposal names. Hidden content and contact details (phone, e-mail, address) are not readable. ' +
    'A long CV comes in parts: pass next_offset back as offset.',
  scope: 'content:read',
  cost: 'cheap',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: false, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    lang: z.enum(['en', 'zh']).optional().describe('en or zh. Absent: both.'),
    section: z.enum(CV_SECTION_NAMES).optional().describe('One section, by sessionName (for example experiences, education).'),
    offset: z.number().int().min(0).max(1000).optional().describe('Where the sections start, from next_offset. Default 0.'),
  }),
  targetOf: (args) => ({ kind: 'cv', ref: args.section ?? 'cv' }),
  read(args, ctx) {
    const view = aiCvView()
    const sections = (['en', 'zh'] as const)
      .filter((lang) => !args.lang || args.lang === lang)
      .flatMap((lang) => view[lang].filter((s) => !args.section || s.sessionName === args.section).map((section) => ({ lang, section })))
    const from = Math.min(args.offset ?? 0, sections.length)
    const part = fitItems(sections.slice(from))
    const next = from + part.length < sections.length ? from + part.length : null
    return ok({
      sections: part,
      offset: from,
      next_offset: next,
      truncated: next !== null,
      public_url: '/cv',
      edit_url: '/admin/dashboard?tab=cv',
      ...(canDraft(ctx) ? { version: kvEtag(readCvDataWithVersion().version) } : {}),
    })
  },
})
