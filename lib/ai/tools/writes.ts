import * as z from 'zod'
import { LINKS_MAX, OUTCOME_LIMITS, OUTCOMES_MAX, SUMMARY_MAX } from '../../caseStudy'
import { ALT_MAX, CAPTION_MAX } from '../../media/meta'
import { FRONTMATTER_KEYS } from '../allowLists'
import { EDIT_LIMITS, utf8Bytes } from '../edits'
import { planCreateDraft, planEditContent } from '../plans/items'
import { planSetMediaText } from '../plans/media'
import { defineWriteTool, type ToolAnnotations } from '../toolTypes'

/**
 * The three draft-safe writes (design §4.2, scope content:draft, risk
 * draft): create_draft, edit_content and set_media_text. Each is a plan
 * (lib/ai/plans) — pure, it writes nothing — and lib/ai/execute decides
 * where the write goes after lib/ai/validate checked it: applied at once
 * through lib/contentOps (draft and pending rows only), or refused when the
 * item would reach someone without the owner's approval (§4.6).
 *
 * Visitors and review-link holders see nothing either way.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** At most `max` bytes of UTF-8 (the caps of §4.5 are bytes). */
const withinBytes = (max: number) => (s: string) => utf8Bytes(s) <= max

/**
 * The frontmatter a write may send: every allow-listed key of posts and
 * case studies (§4.3) with the type its readers use, all optional. A key
 * the collection does not use is refused by lib/ai/validate; any other key,
 * `draft`, the schedule and `translationKey` among them, is
 * FIELD_NOT_EDITABLE (lib/ai/execute, `fieldMaps`).
 */
const FRONTMATTER = z
  .strictObject({
    title: z.string().min(1).max(300).describe('The title. Required for a new item.'),
    description: z.string().max(1000).describe('One or two sentences for search results and cards.'),
    date: z.string().regex(DATE_RE).describe('Posts: the date, YYYY-MM-DD. Required for a new post.'),
    tags: z.array(z.string().min(1).max(100)).max(30).describe('Posts: tags.'),
    cover: z.string().max(2048).describe('Cover image: an upload of this site, /uploads/<name>. Remote images are refused.'),
    coverAlt: z.string().max(300).describe('What the cover shows.'),
    coverFocus: z.string().max(32).describe('Focal point of the cover, "x% y%".'),
    project: z.string().max(128).describe('Posts: slug of the case study the post is about.'),
    lang: z.string().max(35).describe('BCP-47 language, for example en or zh-Hans. Detected when absent.'),
    seoTitle: z.string().max(120).describe('Search-result title; at most 60 characters reads best.'),
    updated: z.string().regex(DATE_RE).describe('Posts: when it was last revised, YYYY-MM-DD.'),
    role: z.string().max(200).describe('Case studies: the role.'),
    period: z.string().max(200).describe('Case studies: the period, for example "2024 - 2025".'),
    tech: z.array(z.string().min(1).max(100)).max(30).describe('Case studies: technologies.'),
    status: z.enum(['live', 'archived', 'case-study']).describe('Case studies: live, archived or case-study.'),
    featured: z.boolean().describe('Case studies: featured on the index.'),
    link: z.string().max(2048).describe('Case studies: https address of the project.'),
    repo: z.string().max(2048).describe('Case studies: https address of the repository.'),
    summary: z.string().max(SUMMARY_MAX).describe('Case studies: one-line outcome under the title, at most 200 characters.'),
    team: z.string().max(200).describe('Case studies: the team.'),
    published: z.string().regex(DATE_RE).describe('Case studies: publication date, YYYY-MM-DD.'),
    outcomes: z
      .array(
        z.strictObject({
          value: z.string().min(1).max(OUTCOME_LIMITS.value).describe('The number as written, for example 93.59.'),
          unit: z.string().max(OUTCOME_LIMITS.unit).optional().describe('Unit after the value, for example %.'),
          label: z.string().min(1).max(OUTCOME_LIMITS.label).describe('What was measured.'),
          source: z.string().max(OUTCOME_LIMITS.source).optional().describe('Where the number comes from.'),
          sourceUrl: z.string().max(2048).optional().describe('Evidence link: https, a site path or a #section.'),
        }),
      )
      .max(OUTCOMES_MAX)
      .describe('Case studies: at most 4 measured outcomes.'),
    links: z
      .array(z.strictObject({ label: z.string().min(1).max(80).describe('Link text.'), url: z.string().min(1).max(2048).describe('The address.') }))
      .max(LINKS_MAX)
      .describe('Case studies: at most 4 extra links (demo, paper, slides).'),
  })
  .partial()

/** The frontmatter of a single page (/now, /uses, the bios) a proposal may send: what its editor writes, and lang. */
export const PAGE_FRONTMATTER = z
  .strictObject({
    title: z.string().min(1).max(300).describe('The page title.'),
    description: z.string().max(1000).describe('One or two sentences for search results.'),
    updated: z.string().regex(DATE_RE).describe('When it was last revised, YYYY-MM-DD.'),
    lang: z.string().max(35).describe('BCP-47 language. Detected when absent.'),
  })
  .partial()

/** Every key the wire object lists, for remove_frontmatter. */
export const FRONTMATTER_WIRE_KEYS = Array.from(new Set([...FRONTMATTER_KEYS.blog, ...FRONTMATTER_KEYS.work])) as [string, ...string[]]

const WRITE_TAGS = { readsPrivate: false, untrustedOutput: false, publicEffect: false, egress: false } as const
const annotations = (destructive: boolean, idempotent: boolean): ToolAnnotations => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false })

const RATIONALE = z.string().max(500).optional().describe('Why, in a sentence, for the owner. At most 500 characters.')
const COLLECTION = z.enum(['blog', 'work']).describe('blog (a post) or work (a case study).')

export const createDraft = defineWriteTool({
  name: 'create_draft',
  title: 'Create a draft',
  description:
    'Create a new post (blog) or case study (work) as a draft: only the owner sees it until they publish it. ' +
    'slug: lowercase letters, digits, - and _. frontmatter: title (required), date YYYY-MM-DD (required for posts) and the keys of ' +
    'get_authoring_guide topic frontmatter. body: MDX, at most 256 KiB; images must be /uploads/<name>. translation_of: the slug of ' +
    'the same piece in another language, to join its translations. Returns change_id, version and edit_url.',
  scope: 'content:draft',
  cost: 'cheap',
  risk: 'draft',
  annotations: annotations(false, false),
  tags: WRITE_TAGS,
  input: z.strictObject({
    collection: COLLECTION,
    slug: z.string().min(1).max(96).describe('The new address: lowercase letters, digits, - and _.'),
    frontmatter: FRONTMATTER.describe('The fields: title, date for posts, and any other allowed key.'),
    body: z.string().refine(withinBytes(EDIT_LIMITS.bodyBytes), 'at most 256 KiB').describe('The MDX body, at most 256 KiB.'),
    translation_of: z.string().min(1).max(128).optional().describe('Slug of the same piece in another language, in this collection.'),
    rationale: RATIONALE,
  }),
  fieldMaps: ['frontmatter'],
  targetOf: (args) => ({ kind: args.collection, ref: args.slug }),
  plan: (args, ctx) => planCreateDraft(args, ctx),
})

export const editContent = defineWriteTool({
  name: 'edit_content',
  title: 'Edit content',
  description:
    'Change a post (blog) or case study (work). A draft stays a draft; a published item\'s change is saved as unpublished changes, ' +
    'so visitors keep seeing the published version until the owner publishes. base_version is the version get_content returned. ' +
    'Send edits (find and replace; each find must match exactly once unless all is true; at most 50) or a whole new body, ' +
    'and/or frontmatter_patch and remove_frontmatter. An item that is scheduled or has active review links cannot be changed here. ' +
    'Returns change_id, the new version and edit_url.',
  scope: 'content:draft',
  cost: 'cheap',
  risk: 'draft',
  annotations: annotations(true, false),
  tags: WRITE_TAGS,
  input: z
    .strictObject({
      collection: COLLECTION,
      slug: z.string().min(1).max(128).describe('The slug of the item.'),
      edits: z
        .array(
          z.strictObject({
            find: z.string().min(1).refine(withinBytes(16 * 1024), 'at most 16 KiB').describe('Exact text to find, at most 16 KiB.'),
            replace: z.string().refine(withinBytes(64 * 1024), 'at most 64 KiB').describe('What replaces it, at most 64 KiB.'),
            all: z.boolean().optional().describe('true replaces every match (at most 1000); otherwise find must match once.'),
          }),
        )
        .min(1)
        .max(EDIT_LIMITS.edits)
        .optional()
        .describe('Find-and-replace edits of the body, applied in order. At most 50. Not with body.'),
      body: z.string().refine(withinBytes(EDIT_LIMITS.bodyBytes), 'at most 256 KiB').optional().describe('A whole new MDX body, at most 256 KiB. Not with edits.'),
      frontmatter_patch: FRONTMATTER.optional().describe('Fields to set; fields left out stay as stored.'),
      remove_frontmatter: z.array(z.enum(FRONTMATTER_WIRE_KEYS)).min(1).max(30).optional().describe('Fields to remove.'),
      base_version: z.string().min(1).max(64).describe('The version get_content returned.'),
      rationale: RATIONALE,
    })
    .superRefine((v, ctx) => {
      if (v.edits && v.body !== undefined) ctx.addIssue({ code: 'custom', path: ['edits'], message: 'send edits or body, not both' })
      const fields = Object.keys(v.frontmatter_patch ?? {}).length + (v.remove_frontmatter?.length ?? 0)
      if (!v.edits && v.body === undefined && fields === 0) ctx.addIssue({ code: 'custom', path: [], message: 'nothing to change: send edits, body, frontmatter_patch or remove_frontmatter' })
    }),
  fieldMaps: ['frontmatter_patch', 'remove_frontmatter'],
  targetOf: (args) => ({ kind: args.collection, ref: args.slug }),
  plan: (args, ctx) => planEditContent(args, ctx),
})

export const setMediaText = defineWriteTool({
  name: 'set_media_text',
  title: 'Set image texts',
  description:
    'Set the default alt text and caption of an uploaded image, in English and Chinese: the editors offer them when the image is inserted, ' +
    'and pages that already show the image do not change. Fields left out keep their value; an empty string clears one. ' +
    'expected_updated_at is the texts_version list_media returned. Alt text says what the image shows, at most 300 characters; captions at most 500.',
  scope: 'content:draft',
  cost: 'cheap',
  risk: 'draft',
  annotations: annotations(true, true),
  tags: WRITE_TAGS,
  input: z
    .strictObject({
      name: z.string().min(1).max(200).describe('The upload name, as list_media shows it.'),
      alt: z.string().max(ALT_MAX).optional().describe('English alt text.'),
      alt_zh: z.string().max(ALT_MAX).optional().describe('Chinese alt text.'),
      caption: z.string().max(CAPTION_MAX).optional().describe('English caption.'),
      caption_zh: z.string().max(CAPTION_MAX).optional().describe('Chinese caption.'),
      expected_updated_at: z.number().int().min(0).describe('texts_version from list_media (0 when the image has no texts yet).'),
      rationale: RATIONALE,
    })
    .superRefine((v, ctx) => {
      if ([v.alt, v.alt_zh, v.caption, v.caption_zh].every((t) => t === undefined)) ctx.addIssue({ code: 'custom', path: [], message: 'send at least one of alt, alt_zh, caption, caption_zh' })
    }),
  targetOf: (args) => ({ kind: 'media', ref: args.name }),
  plan: (args) => planSetMediaText(args),
})
