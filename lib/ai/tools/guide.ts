import * as z from 'zod'
import { OUTCOMES_MAX, SUMMARY_MAX } from '../../caseStudy'
import { CV_SECTIONS, type FieldDef, type ListDef } from '../../cvSections'
import { HOME_LIMITS } from '../../homeShape'
import { CV_DENIED_KEYS, FRONTMATTER_KEYS, FRONTMATTER_REFUSED, HOME_EDIT_PATHS, HOME_REFUSED } from '../allowLists'
import { READ_ANNOTATIONS, defineTool, ok } from '../toolTypes'
import { AI_CV_STRIP } from '../views'

/**
 * get_authoring_guide (design §4.2): how content on this site is written,
 * generated from the code that enforces it — the CV section registry
 * (lib/cvSections), the home limits (lib/homeShape), the write allow-lists
 * (lib/ai/allowLists) and the MDX renderer's rules (lib/mdx,
 * lib/rehype/stripMdxExpressions). Static: nothing private, no store read.
 */

const TOPICS = ['mdx', 'frontmatter', 'cv', 'home'] as const
type Topic = (typeof TOPICS)[number]

const MDX_GUIDE = [
  '# Writing MDX for this site',
  '',
  'Bodies are Markdown with GitHub extensions (tables, task lists, strikethrough, footnotes) and a few JSX elements. Nothing is ever evaluated:',
  '`{expressions}`, `import` and `export` are removed, and attributes must be literal strings or booleans.',
  '',
  '## Structure',
  '- The title is the page heading: start the body at `##`. Do not skip levels (`##` then `###`).',
  '- Separate paragraphs with a blank line. Do not use `\\` or `<br />` to make empty lines.',
  '- Callouts: a blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`.',
  '- Code: fenced blocks with a language, for example ```ts.',
  '',
  '## Images',
  '- Only uploads of this site: `![Alt text](/uploads/<name>)`. Find names with list_media. A remote image address is refused:',
  '  the image is imported into the uploads first (the owner approves an import), then referenced as `/uploads/<name>`.',
  '- Every image needs real alt text that says what the picture shows (not a file name). A caption: `<Figure src="/uploads/<name>" alt="..." caption="..." />`.',
  '- Width: add `#wide` or `#full` to the address, or `size="wide"` / `size="full"` on `<Figure>`. Consecutive images form a gallery.',
  '',
  '## Allowed JSX',
  '- `<Figure src alt caption size />` (above).',
  '- `<YouTube id="<11-character id>" title="..." />`, and `<iframe src>` only for youtube-nocookie.com/embed, youtube.com/embed or player.vimeo.com/video.',
  '- Presentational tags without attributes: `br`, `kbd`, `sub`, `sup`, `mark`, `small`, `summary`; `abbr title="..."`; `details open`.',
  '- Anything else is replaced by its text.',
  '',
  '## Links and language',
  '- Link to this site with paths (`/blog/<slug>`, `/work/<slug>`). External links are kept as written and shown to the owner for review.',
  '- Chinese text is written by the owner. Translate only when the owner asks, and only as a draft or proposal they review.',
  '',
  '## Changing content',
  '- Read first (get_content), then name the version it returned as base_version. A changed item answers VERSION_CONFLICT: read it again.',
  '- Drafts and unpublished changes are private. Anything that would reach visitors is a proposal the owner approves on the site.',
  '- With draft access: create_draft starts a post or case study as a draft; edit_content changes a draft, or saves a published item’s change as',
  '  unpublished changes (visitors keep the published version); set_media_text sets an image’s default alt text and caption.',
  '- Prefer edits (find and replace) to a whole new body: each find must match exactly once, so nothing else changes by accident.',
  '- An item that is scheduled or has active review links can only be changed through the owner’s approval.',
].join('\n')

const FRONTMATTER_TYPES: Record<string, string> = {
  title: 'string, required',
  description: 'string, one or two sentences for search results and cards',
  date: 'YYYY-MM-DD, required for posts',
  tags: 'list of strings',
  cover: 'string: /uploads/<name> or a site path',
  coverAlt: 'string: what the cover shows',
  coverFocus: 'string: focal point "x% y%"',
  project: 'string: slug of the case study the post is about',
  lang: 'string: BCP-47 language, for example en or zh-Hans (detected when absent)',
  seoTitle: 'string: search-result title, at most 60 characters',
  updated: 'YYYY-MM-DD: when the post was last revised',
  role: 'string',
  period: 'string, for example "2024 - 2025"',
  tech: 'list of strings (technologies, also the archive filter)',
  status: 'live, archived or case-study',
  featured: 'boolean',
  link: 'string: https address of the project',
  repo: 'string: https address of the repository',
  summary: `string: one-line outcome under the title, at most ${SUMMARY_MAX} characters`,
  team: 'string',
  published: 'YYYY-MM-DD',
  outcomes: `list of at most ${OUTCOMES_MAX} objects { value, unit?, label, source? } (strings)`,
  links: 'list of at most 4 objects { label, url } (strings)',
}

function frontmatterGuide() {
  const lines = ['# Frontmatter', '', 'Keys a change may set, per collection. Keys not listed stay as stored.', '']
  for (const c of ['blog', 'work'] as const) {
    lines.push(`## ${c === 'blog' ? 'Posts (blog)' : 'Case studies (work)'}`)
    for (const k of FRONTMATTER_KEYS[c]) lines.push(`- ${k}: ${FRONTMATTER_TYPES[k] ?? 'string'}`)
    lines.push('')
  }
  lines.push(`Never settable: ${FRONTMATTER_REFUSED.join(', ')}. Publishing and scheduling are separate actions the owner approves; the server links translations.`)
  return { text: lines.join('\n'), keys: FRONTMATTER_KEYS, refused: FRONTMATTER_REFUSED }
}

type FieldSummary = { key: string; kind: string; label: string; required?: true }
type ListSummary = { key: string; label: string; item: string; fields: FieldSummary[]; lists?: ListSummary[] }

function fieldsOf(defs: readonly FieldDef[] | undefined, stripped: ReadonlySet<string>): FieldSummary[] {
  return (defs ?? [])
    .filter((f) => !stripped.has(f.key) && !CV_DENIED_KEYS.includes(f.key))
    .map((f) => ({ key: f.key, kind: f.kind, label: f.label, ...(f.required ? { required: true as const } : {}) }))
}

function listsOf(defs: readonly ListDef[] | undefined, stripped: ReadonlySet<string>): ListSummary[] {
  return (defs ?? []).map((l) => {
    const nested = listsOf(l.lists, stripped)
    return { key: l.key, label: l.label, item: l.itemNoun, fields: fieldsOf(l.fields, stripped), ...(nested.length ? { lists: nested } : {}) }
  })
}

function cvGuide() {
  const sections = CV_SECTIONS.map((s) => {
    const stripped = new Set(AI_CV_STRIP[s.sessionName] ?? [])
    return { section: s.sessionName, label: s.label, description: s.description, fields: fieldsOf(s.fields, stripped), lists: listsOf(s.lists, stripped) }
  })
  const text = [
    '# The CV',
    '',
    'Two languages (en, zh), each a list of sections named by sessionName. get_cv shows the public view: entries carry a uid that a CV proposal names.',
    'A proposal patches: set_field (lang, section, uid for an entry field, field, value_json), add_entry (lang, section, value_json) or remove_entry (lang, section, uid).',
    `Never writable: ${CV_DENIED_KEYS.join(', ')}, contact fields (phone, e-mail, address), a hidden field, and a list that has hidden items.`,
    'Only what the public view shows can be targeted; a hidden entry answers like an unknown one.',
  ].join('\n')
  return { text, sections }
}

function homeGuide() {
  const text = [
    '# The home page',
    '',
    'get_home shows it as visitors see it. A home proposal is a list of operations { path, value_json }; array positions [n] are positions in that view.',
    `Paths a proposal may set: ${HOME_EDIT_PATHS.join('; ')}.`,
    `Never writable: ${HOME_REFUSED.join(', ')}.`,
    `Replacing the whole highlights list works only while every stored highlight is visible. Limits: at most ${HOME_LIMITS.featuredMax} open-source picks (blurb ${HOME_LIMITS.featuredBlurbMax} characters), ` +
      `site name ${HOME_LIMITS.siteNameMax} characters, availability label ${HOME_LIMITS.availabilityLabelMax} characters, ${HOME_LIMITS.rolesMax} roles of ${HOME_LIMITS.roleMax} characters.`,
  ].join('\n')
  return { text, paths: HOME_EDIT_PATHS, refused: HOME_REFUSED, limits: HOME_LIMITS }
}

const GUIDES: Record<Topic, () => Record<string, unknown>> = {
  mdx: () => ({ text: MDX_GUIDE }),
  frontmatter: frontmatterGuide,
  cv: cvGuide,
  home: homeGuide,
}

export const getAuthoringGuide = defineTool({
  name: 'get_authoring_guide',
  title: 'Read the authoring guide',
  description:
    'How content on this site is written and what a change may touch. Call it before writing: topic mdx (body syntax, images, allowed elements), ' +
    'frontmatter (the keys of posts and case studies), cv (sections and fields) or home (the paths a home proposal may set).',
  scope: 'content:read',
  cost: 'cheap',
  risk: 'read',
  annotations: READ_ANNOTATIONS,
  tags: { readsPrivate: false, untrustedOutput: false, publicEffect: false, egress: false },
  input: z.strictObject({
    topic: z.enum(TOPICS).describe('mdx, frontmatter, cv or home.'),
  }),
  targetOf: () => null,
  read(args) {
    return ok({ topic: args.topic, ...GUIDES[args.topic]() })
  },
})
