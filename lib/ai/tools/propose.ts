import * as z from 'zod'
import { CV_SECTIONS } from '../../cvSections'
import { planApplyAlt } from '../plans/alt'
import { CV_OPS, planCvEdit } from '../plans/cv'
import { MAX_FIXES, planContentFix } from '../plans/health'
import { planHomeEdit } from '../plans/home'
import { DELETE_TARGETS, planDelete, planMediaImport } from '../plans/mediaProposals'
import { planPageEdit } from '../plans/pages'
import { PUBLISHING_ACTIONS, planPublishing } from '../plans/publishing'
import { planRestore } from '../plans/restore'
import { planTagChange } from '../plans/tags'
import { EDIT_LIMITS, utf8Bytes } from '../edits'
import { defineWriteTool, type ToolAnnotations, type ToolTags } from '../toolTypes'
import { PAGE_FRONTMATTER } from './writes'

/**
 * The ten proposals (design §4.2, scope content:propose). Each call only
 * stores a waiting change — the canonical arguments, the preview the owner
 * approves and the state it would replace — and returns
 * `waiting_for_owner`. Nothing changes until the owner approves it on the
 * site (pages/api/admin/ai/changes/[id]/approve, lib/ai/apply), which runs
 * the same plan again and executes only if the preview is the same.
 */

const RATIONALE = z.string().min(1).max(500).describe('Why, in a sentence or two, for the owner. Required, at most 500 characters.')
const BASE_VERSION = z.string().min(1).max(64).describe('The version a read returned (get_content, get_home, get_cv, list_versions target).')
const COLLECTION = z.enum(['blog', 'work']).describe('blog (a post) or work (a case study).')
const VALUE_JSON = z
  .string()
  .max(64 * 1024)
  .describe('The new value as JSON text: a string is "New text", a list is ["a", "b"], an object is {"k": "v"}. At most 64 KiB.')

const annotations = (openWorld = false): ToolAnnotations => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: openWorld })
const TAGS: ToolTags = { readsPrivate: false, untrustedOutput: false, publicEffect: true, egress: false }

const withinBytes = (max: number) => (s: string) => utf8Bytes(s) <= max
const EDITS = z
  .array(
    z.strictObject({
      find: z.string().min(1).refine(withinBytes(16 * 1024), 'at most 16 KiB').describe('Exact text to find, at most 16 KiB.'),
      replace: z.string().refine(withinBytes(64 * 1024), 'at most 64 KiB').describe('What replaces it, at most 64 KiB.'),
      all: z.boolean().optional().describe('true replaces every match (at most 1000); otherwise find must match once.'),
    }),
  )
  .min(1)
  .max(EDIT_LIMITS.edits)

export const proposePublishing = defineWriteTool({
  name: 'propose_publishing',
  title: 'Propose publishing',
  description:
    'Propose to publish, unpublish, schedule, clear the schedule of, or discard the unpublished changes of a post (blog) or case study (work). ' +
    'publish: a draft goes live, or a live item\'s unpublished changes go live (mark_updated true sets a post\'s updated date). ' +
    'schedule: publish_at and/or unpublish_at as ISO 8601 times with a time zone. base_version is the version get_content returned.' +
    ' Returns status waiting_for_owner with change_id and review_url: nothing changes until the owner approves it on the site.',
  scope: 'content:propose',
  cost: 'cheap',
  risk: 'live',
  annotations: annotations(),
  tags: TAGS,
  input: z.strictObject({
    collection: COLLECTION,
    slug: z.string().min(1).max(128).describe('The slug of the item.'),
    action: z.enum(PUBLISHING_ACTIONS).describe('publish, unpublish, schedule, unschedule or discard_changes.'),
    publish_at: z.string().max(64).optional().describe('schedule: when it goes live, for example 2026-12-01T09:00:00+08:00.'),
    unpublish_at: z.string().max(64).optional().describe('schedule: when it comes down again.'),
    mark_updated: z.boolean().optional().describe('Posts with unpublished changes: set updated to the day they go live.'),
    base_version: BASE_VERSION,
    rationale: RATIONALE,
  }),
  targetOf: (args) => ({ kind: args.collection, ref: args.slug }),
  plan: (args, ctx) => planPublishing(args, ctx),
})

export const proposePageEdit = defineWriteTool({
  name: 'propose_page_edit',
  title: 'Propose a page edit',
  description:
    'Propose a change to a single page: now, uses, about (the About bio) or about-zh (the Chinese bio). They have no unpublished state, so a change waits for the owner. ' +
    'Send edits (find and replace, at most 50) or a whole new body, and/or frontmatter_patch (title, description, updated, lang) and remove_frontmatter. ' +
    'An empty page is refused. base_version is the version get_content returned.' +
    ' Returns status waiting_for_owner with change_id and review_url: nothing changes until the owner approves it on the site.',
  scope: 'content:propose',
  cost: 'cheap',
  risk: 'live',
  annotations: annotations(),
  tags: TAGS,
  input: z
    .strictObject({
      name: z.enum(['now', 'uses', 'about', 'about-zh']).describe('now, uses, about or about-zh.'),
      edits: EDITS.optional().describe('Find-and-replace edits of the body, applied in order. Not with body.'),
      body: z.string().refine(withinBytes(EDIT_LIMITS.bodyBytes), 'at most 256 KiB').optional().describe('A whole new MDX body, at most 256 KiB. Not with edits.'),
      frontmatter_patch: PAGE_FRONTMATTER.optional().describe('Fields to set; fields left out stay as stored.'),
      remove_frontmatter: z.array(z.enum(['description', 'updated', 'lang'])).min(1).max(3).optional().describe('Fields to remove.'),
      base_version: BASE_VERSION,
      rationale: RATIONALE,
    })
    .superRefine((v, ctx) => {
      if (v.edits && v.body !== undefined) ctx.addIssue({ code: 'custom', path: ['edits'], message: 'send edits or body, not both' })
      const fields = Object.keys(v.frontmatter_patch ?? {}).length + (v.remove_frontmatter?.length ?? 0)
      if (!v.edits && v.body === undefined && fields === 0) ctx.addIssue({ code: 'custom', path: [], message: 'nothing to change: send edits, body, frontmatter_patch or remove_frontmatter' })
    }),
  fieldMaps: ['frontmatter_patch', 'remove_frontmatter'],
  targetOf: (args) => ({ kind: 'page', ref: args.name }),
  plan: (args, ctx) => planPageEdit(args, ctx),
})

export const proposeHomeEdit = defineWriteTool({
  name: 'propose_home_edit',
  title: 'Propose a home page edit',
  description:
    'Propose changes to the home page as a list of operations { path, value_json }, at most 50. Paths are those of get_authoring_guide topic home, ' +
    'for example hero.tagline, quickAccess[0].label, photos[1].describe or highlights[0].href; [n] is the position in get_home. ' +
    'value_json is the new value as JSON text, for example "New tagline" or [{"label":"Blog","url":"/blog"}]. base_version is the version get_home returned.' +
    ' Returns status waiting_for_owner with change_id and review_url: nothing changes until the owner approves it on the site.',
  scope: 'content:propose',
  cost: 'cheap',
  risk: 'live',
  annotations: annotations(),
  tags: TAGS,
  input: z.strictObject({
    ops: z
      .array(z.strictObject({ path: z.string().min(1).max(200).describe('Where, for example hero.tagline or photos[1].describe.'), value_json: VALUE_JSON }))
      .min(1)
      .max(50)
      .describe('The operations, applied in order. At most 50.'),
    base_version: BASE_VERSION,
    rationale: RATIONALE,
  }),
  targetOf: () => ({ kind: 'home', ref: 'home' }),
  plan: (args, ctx) => planHomeEdit(args, ctx),
})

const CV_SECTION_NAMES = CV_SECTIONS.map((s) => s.sessionName) as [string, ...string[]]

export const proposeCvEdit = defineWriteTool({
  name: 'propose_cv_edit',
  title: 'Propose a CV edit',
  description:
    'Propose changes to the CV as patches, at most 50: set_field (lang, section, uid for an entry field, field, value_json), ' +
    'add_entry (lang, section, value_json with the entry\'s fields; field names the list when a section has several, such as skill: languages or technical) ' +
    'or remove_entry (lang, section, uid). Sections are sessionNames and uids come from get_cv; only what get_cv shows can be changed. ' +
    'value_json is JSON text, for example "Senior engineer" or ["Go","Rust"]. base_version is the version get_cv returned.' +
    ' Returns status waiting_for_owner with change_id and review_url: nothing changes until the owner approves it on the site.',
  scope: 'content:propose',
  cost: 'cheap',
  risk: 'live',
  annotations: annotations(),
  tags: TAGS,
  input: z.strictObject({
    ops: z
      .array(
        z.strictObject({
          op: z.enum(CV_OPS).describe('set_field, add_entry or remove_entry.'),
          lang: z.enum(['en', 'zh']).describe('en or zh.'),
          section: z.enum(CV_SECTION_NAMES).describe('The section, by sessionName.'),
          uid: z.string().min(1).max(64).optional().describe('The entry, by the uid get_cv showed. Required for an entry field and for remove_entry.'),
          field: z.string().min(1).max(64).optional().describe('set_field: the field. add_entry: the list, when the section has several.'),
          value_json: VALUE_JSON.optional(),
        }),
      )
      .min(1)
      .max(50)
      .describe('The patches, applied in order. At most 50.'),
    base_version: BASE_VERSION,
    rationale: RATIONALE,
  }),
  targetOf: () => ({ kind: 'cv', ref: 'cv' }),
  plan: (args, ctx) => planCvEdit(args, ctx),
})

export const proposeTagChange = defineWriteTool({
  name: 'propose_tag_change',
  title: 'Propose a tag change',
  description:
    'Propose to rename one tag, or merge several into one, on every post (blog: tags) or case study (work: tech), drafts and unpublished changes included. ' +
    'from lists tag slugs (lowercase, as search_content shows them); to is the new name.' +
    ' Returns status waiting_for_owner with change_id and review_url: nothing changes until the owner approves it on the site.',
  scope: 'content:propose',
  cost: 'cheap',
  risk: 'live',
  annotations: annotations(),
  tags: TAGS,
  input: z.strictObject({
    collection: COLLECTION,
    from: z.array(z.string().min(1).max(64)).min(1).max(50).describe('Slugs of the tags to rename (one) or merge (several).'),
    to: z.string().min(1).max(64).describe('The new tag name.'),
    rationale: RATIONALE,
  }),
  targetOf: (args) => ({ kind: 'tags', ref: args.collection }),
  plan: (args, ctx) => planTagChange(args, ctx),
})

export const proposeRestore = defineWriteTool({
  name: 'propose_restore',
  title: 'Propose restoring a version',
  description:
    'Propose to restore a saved version (list_versions) of a post (blog), case study (work), page (ref: now, uses, about, about-zh), the home page or the CV. ' +
    'It replaces the whole current state, so the owner confirms it with a fresh sign-in. ref is the slug or page name (not used for home and cv); ' +
    'a deleted post or case study is restored with base_version "0".' +
    ' Returns status waiting_for_owner with change_id and review_url: nothing changes until the owner approves it on the site.',
  scope: 'content:propose',
  cost: 'cheap',
  risk: 'destructive',
  annotations: annotations(),
  tags: TAGS,
  input: z.strictObject({
    collection: z.enum(['blog', 'work', 'page', 'home', 'cv']).describe('blog, work, page, home or cv.'),
    ref: z.string().min(1).max(128).optional().describe('The slug (blog, work) or page name. Required for blog, work and page.'),
    filename: z.string().min(1).max(200).describe('The version, as list_versions named it.'),
    base_version: BASE_VERSION,
    rationale: RATIONALE,
  }),
  targetOf: (args) => ({ kind: args.collection, ref: args.ref ?? args.collection }),
  plan: (args, ctx) => planRestore(args, ctx),
})

export const proposeContentFix = defineWriteTool({
  name: 'propose_content_fix',
  title: 'Propose content health fixes',
  description:
    'Propose the automatic fixes of content health issues (get_content_health): strip tracking parameters, point a moved link at its new address, make paragraphs, import a remote image. ' +
    "fixes lists each issue's id with its item's version, at most 100. Issues without a fix, and generating image sizes, are not proposals." +
    ' Returns status waiting_for_owner with change_id and review_url: nothing changes until the owner approves it on the site.',
  scope: 'content:propose',
  cost: 'expensive',
  risk: 'live',
  annotations: annotations(),
  tags: TAGS,
  input: z.strictObject({
    fixes: z
      .array(
        z.strictObject({
          id: z.string().min(2).max(48).describe('The issue id from get_content_health.'),
          version: z.number().int().min(0).describe('The version of the issue\'s item, from the same report.'),
        }),
      )
      .min(1)
      .max(MAX_FIXES)
      .describe('The issues to fix, at most 100.'),
    rationale: RATIONALE,
  }),
  targetOf: () => ({ kind: 'health', ref: 'content' }),
  plan: (args, ctx) => planContentFix(args, ctx),
})

export const proposeApplyAlt = defineWriteTool({
  name: 'propose_apply_alt',
  title: 'Propose filling in alt text',
  description:
    'Propose to fill in an uploaded image\'s default alt text (set_media_text) wherever a post, case study or page shows the image without one, ' +
    'in each document\'s language. name is the upload name from list_media.' +
    ' Returns status waiting_for_owner with change_id and review_url: nothing changes until the owner approves it on the site.',
  scope: 'content:propose',
  cost: 'expensive',
  risk: 'live',
  annotations: annotations(),
  tags: TAGS,
  input: z.strictObject({
    name: z.string().min(1).max(200).describe('The upload name, as list_media shows it.'),
    rationale: RATIONALE,
  }),
  targetOf: (args) => ({ kind: 'media', ref: args.name }),
  plan: (args, ctx) => planApplyAlt(args, ctx),
})

export const proposeMediaImport = defineWriteTool({
  name: 'propose_media_import',
  title: 'Propose importing an image',
  description:
    'Propose to import a remote image into the uploads, so posts can use it as /uploads/<name>. url must be https with a host name. ' +
    'Nothing is fetched until the owner approves.' +
    ' Returns status waiting_for_owner with change_id and review_url: nothing changes until the owner approves it on the site.',
  scope: 'content:propose',
  cost: 'cheap',
  risk: 'live',
  annotations: annotations(true),
  tags: { ...TAGS, egress: true },
  input: z.strictObject({
    url: z.string().min(1).max(2048).describe('The https address of the image.'),
    rationale: RATIONALE,
  }),
  targetOf: () => ({ kind: 'media', ref: 'import' }),
  plan: (args, ctx) => planMediaImport(args, ctx),
})

export const proposeDelete = defineWriteTool({
  name: 'propose_delete',
  title: 'Propose a deletion',
  description:
    'Propose to delete a post or case study (it stays in the history and can be restored), or to move an unused uploaded image to the trash (restorable for 30 days). ' +
    'target is post, case_study or image; ref the slug or upload name; base_version (the version get_content returned) is required for a post or case study. ' +
    'The owner confirms it with a fresh sign-in.' +
    ' Returns status waiting_for_owner with change_id and review_url: nothing changes until the owner approves it on the site.',
  scope: 'content:propose',
  cost: 'cheap',
  risk: 'destructive',
  annotations: annotations(),
  tags: TAGS,
  input: z.strictObject({
    target: z.enum(DELETE_TARGETS).describe('post, case_study or image.'),
    ref: z.string().min(1).max(200).describe('The slug, or the upload name.'),
    base_version: BASE_VERSION.optional(),
    rationale: RATIONALE,
  }),
  targetOf: (args) => ({ kind: args.target === 'image' ? 'media' : args.target === 'post' ? 'blog' : 'work', ref: args.ref }),
  plan: (args, ctx) => planDelete(args, ctx),
})
