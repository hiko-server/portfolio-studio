import { VISIBILITY_KEYS } from '../cvVisibility'

/**
 * What an AI write may touch (SERVER-ONLY data, design §4.3, §4.4). One list
 * for every reader: the authoring guide (get_authoring_guide) tells a model
 * exactly what the write path accepts, and the write path (lib/ai/validate,
 * stage M2) refuses everything else.
 */

export type AiItemCollection = 'blog' | 'work'

/** Frontmatter keys a tool may write, per collection (§4.3). Keys not listed stay as stored. */
export const FRONTMATTER_KEYS: Readonly<Record<AiItemCollection, readonly string[]>> = Object.freeze({
  blog: ['title', 'description', 'date', 'tags', 'cover', 'coverAlt', 'coverFocus', 'project', 'lang', 'seoTitle', 'updated'],
  work: [
    'title',
    'description',
    'role',
    'period',
    'tech',
    'status',
    'featured',
    'link',
    'repo',
    'cover',
    'coverAlt',
    'coverFocus',
    'summary',
    'team',
    'published',
    'outcomes',
    'links',
    'seoTitle',
    'lang',
  ],
})

/** Frontmatter keys always refused: the published state, the schedule and translation links are the server's. */
export const FRONTMATTER_REFUSED: readonly string[] = ['draft', 'publishAt', 'unpublishAt', 'translationKey']

/** Home paths a proposal may set (§4.3); `[n]` is an index into the public view, `.*` any key below. */
export const HOME_EDIT_PATHS: readonly string[] = [
  'hero.(welcome|brand|tagline|tagline_zh)',
  'hero.currentlyCoding.(label|project|note|label_zh|project_zh|note_zh)',
  'quickAccess',
  'quickAccess[n].(label|url)',
  'photos[n].(describe|describe_zh|redirectTo)',
  'highlights',
  'highlights[n].(value|label|href|value_zh|label_zh)',
  'contact.(heading|blurb|eyebrow|reasons|intents|heading_zh|blurb_zh|eyebrow_zh|reasons_zh)',
  'availability.*',
  'openSource.*',
  'site.*',
  'socials.(github|gitlab|linkedin)',
]

/** Home paths always refused (§4.3): contact details, the portrait, logos (a server fetch), photo files and visibility, layout. */
export const HOME_REFUSED: readonly string[] = [
  'hero.phone',
  'hero.email',
  'hero.avatarUrl',
  'hero.avatarTransform',
  'socials.whatsapp',
  'brands',
  'photos[n].url',
  'photos[n].visible',
  'sections',
  'sectionOrder',
]

/**
 * CV keys no proposal may write, at any depth (§4.4): visibility and
 * audience switches, consent, the PDF photo, editor bookkeeping and entry
 * ids. The ORCID marker and the contact fields (lib/ai/views AI_CV_STRIP) are
 * refused with them.
 */
export const CV_DENIED_KEYS: readonly string[] = [
  ...VISIBILITY_KEYS,
  'permission',
  'photo',
  'photoOnPdf',
  'readinessDismissed',
  'uid',
]
