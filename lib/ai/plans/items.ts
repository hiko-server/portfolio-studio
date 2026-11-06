import { documentText } from '../../../components/Admin/shell/textDiff'
import { heldReason, prepareDraftCreate, prepareDraftEdit, type DraftProblem } from '../../contentOps/drafts'
import { ITEM_RULES, type Collection } from '../../contentOps/rules'
import { isDraftFrontmatter, isSafeSlug, readOne } from '../../mdx-admin'
import { getPendingRevision } from '../../pendingRevisions'
import { detectContentLang } from '../../toc'
import { normalizeTranslationKey, translationLang } from '../../translations'
import { listItems } from '../../contentStore'
import { applyEdits, type TextEdit } from '../edits'
import type { ToolContext, ToolRefusal } from '../toolTypes'
import type { BeforeState, WritePlan } from './types'

/**
 * Plans of the draft-safe item writes (pure: they read the content as it is
 * and write nothing; design §4.1, §4.2): `create_draft` and `edit_content`.
 *
 * Both compute the exact row lib/contentOps/drafts would store (its
 * prepareDraftCreate / prepareDraftEdit, the same functions its writers
 * run), so the preview, the stored arguments and the write cannot differ.
 * Visitors and review-link holders see nothing either way: a new item is a
 * draft, a draft stays one, and a published item's edit is its pending
 * revision.
 */

const ROUTE: Record<Collection, string> = { blog: 'admin/posts', work: 'admin/work' }
const editUrl = (c: Collection, slug: string) => `/admin/${c}/edit?slug=${encodeURIComponent(slug)}`

const refuse = (code: ToolRefusal['code'], message: string, data?: Record<string, unknown>): ToolRefusal => ({ ok: false, code, message, ...(data ? { data } : {}) })

/** The tool answer to a refusal of lib/contentOps/drafts. */
export function draftRefusal(p: DraftProblem): ToolRefusal {
  switch (p.code) {
    case 'SLUG_EXISTS':
      return refuse('SLUG_EXISTS', `${p.error}. Pick another slug, or edit that one with edit_content.`)
    case 'SLUG_RESERVED':
      return refuse('SLUG_RESERVED', `${p.error}.`, { reason: p.reason })
    case 'VERSION_CONFLICT':
      return refuse('VERSION_CONFLICT', `${p.error}.`, { current_version: p.version })
    case 'ITEM_SCHEDULED':
      return refuse('ITEM_SCHEDULED', `${p.error}. Ask the owner to make this change, or to unschedule the item first. Nothing was saved.`, {
        scheduled_at: new Date(p.publishAt).toISOString(),
      })
    case 'ITEM_IN_REVIEW':
      return refuse('ITEM_IN_REVIEW', `${p.error}. Ask the owner to make this change, or to end the review links first. Nothing was saved.`, {
        active_review_links: p.activeLinks,
      })
    case 'NOT_FOUND':
      return refuse('NOT_FOUND', 'Nothing exists at that address. Check the collection and slug with search_content.')
    case 'INVALID_INPUT':
      return refuse('INVALID_INPUT', `${p.error}.`)
    default:
      return refuse('UNAVAILABLE', 'The site could not save this just now. Try again later.')
  }
}

const noun = (c: Collection) => ITEM_RULES[c].noun

type Frontmatter = Record<string, unknown>

/** The value as stored text: undefined keys dropped (what a JSON round trip keeps). */
const plain = (fm: Frontmatter): Frontmatter => JSON.parse(JSON.stringify(fm)) as Frontmatter

// ── create_draft ─────────────────────────────────────────────────────────

export type CreateDraftArgs = {
  collection: Collection
  slug: string
  frontmatter: Frontmatter
  body: string
  translation_of?: string
  rationale?: string
}

/**
 * translation_of: the partner's existing translation key, copied — never a
 * new one (the owner links translations). Refused with the reason when the
 * partner has none, is in the same language, or its group already has a
 * version in this language (which would make the group ambiguous).
 */
function translationKeyFor(c: Collection, partnerSlug: string, fm: Frontmatter, body: string): { ok: true; key: string } | ToolRefusal {
  const partner = isSafeSlug(partnerSlug) ? readOne(c, partnerSlug) : null
  if (!partner) return refuse('NOT_FOUND', `translation_of: there is no ${noun(c)} with that slug in this collection.`, { field: 'translation_of' })
  const key = normalizeTranslationKey(partner.frontmatter.translationKey)
  if (!key) {
    return refuse(
      'INVALID_INPUT',
      `translation_of: that ${noun(c)} has no translation key, so nothing links to it yet. The owner sets one in its editor (Translations); ask them, or create the draft without translation_of.`,
      { field: 'translation_of' },
    )
  }
  const lang = translationLang(detectContentLang({ lang: fm.lang, title: fm.title, body }))
  const partnerLang = translationLang(detectContentLang({ lang: partner.frontmatter.lang, title: partner.frontmatter.title, body: partner.body }))
  if (lang === partnerLang) return refuse('INVALID_INPUT', `translation_of: the draft is in the same language as that ${noun(c)} (${lang}). Set frontmatter.lang to the translation's language.`, { field: 'translation_of' })
  const clash = listItems(c).find(
    (i) => normalizeTranslationKey(i.frontmatter?.translationKey) === key && translationLang(detectContentLang({ lang: i.frontmatter?.lang, title: i.frontmatter?.title, body: i.body })) === lang,
  )
  if (clash) return refuse('INVALID_INPUT', `translation_of: the ${noun(c)} ${clash.slug} is already the ${lang} version of that piece. Edit it instead.`, { field: 'translation_of', existing: clash.slug })
  return { ok: true, key }
}

export function planCreateDraft(args: CreateDraftArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const c = args.collection
  let fm: Frontmatter = plain(args.frontmatter ?? {})
  if (args.translation_of !== undefined) {
    const t = translationKeyFor(c, args.translation_of, fm, args.body)
    if (!t.ok) return t
    fm = { ...fm, translationKey: t.key }
  }
  const prepared = prepareDraftCreate(c, { slug: args.slug, frontmatter: fm, body: args.body }, { now: ctx.now })
  if (!prepared.ok) return draftRefusal(prepared)
  const before: BeforeState = { kind: 'item', collection: c, slug: args.slug, live: null, pending: null }
  return {
    kind: 'item.create',
    risk: 'draft',
    target: { kind: c, ref: args.slug },
    baseVersion: null,
    args: { collection: c, slug: args.slug, frontmatter: fm, body: args.body },
    rationale: args.rationale ?? null,
    before,
    preview: {
      kind: 'item.create',
      risk: 'draft',
      title: `New draft ${noun(c)} ${args.slug}`,
      documents: [{ ref: `${c}/${args.slug}`, label: `Draft ${noun(c)} ${args.slug}`, publicUrl: null, format: 'mdx', before: '', after: documentText(prepared.frontmatter, prepared.body) }],
      effects: { publicPaths: [], schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    held: null,
    // translationKey is the server's (resolved above): only the keys the model sent are checked against the allow-list.
    check: { kind: 'item', collection: c, touchedKeys: Object.keys(args.frontmatter ?? {}), frontmatter: prepared.frontmatter, body: prepared.body, before: null },
    audit: { route: ROUTE[c], method: 'PUT', body: { slug: args.slug, frontmatter: prepared.frontmatter, create: true } },
    editUrl: editUrl(c, args.slug),
  }
}

// ── edit_content ─────────────────────────────────────────────────────────

export type EditContentArgs = {
  collection: Collection
  slug: string
  edits?: TextEdit[]
  body?: string
  frontmatter_patch?: Frontmatter
  remove_frontmatter?: string[]
  base_version: string
  rationale?: string
}

function editsRefusal(out: Exclude<ReturnType<typeof applyEdits>, { ok: true }>): ToolRefusal {
  const at = out.index === null ? 'edits' : `edits[${out.index}]`
  switch (out.code) {
    case 'EDIT_NOT_FOUND':
      return refuse('EDIT_NOT_FOUND', `${at}: find does not occur in the current text (read it again with get_content). Nothing was changed.`, { field: at, find: out.find.slice(0, 200) })
    case 'EDIT_AMBIGUOUS':
      return refuse('EDIT_AMBIGUOUS', `${at}: find occurs more than once. Make it longer so it matches one place, or set all: true. Nothing was changed.`, { field: at, find: out.find.slice(0, 200) })
    case 'EDIT_TOO_LARGE':
      return refuse(
        'EDIT_TOO_LARGE',
        out.reason === 'matches' ? `${at}: more than 1000 matches. Nothing was changed.` : `${at}: the body would be larger than 256 KiB. Nothing was changed.`,
        { field: at },
      )
    default:
      return refuse('INVALID_INPUT', `${at}: ${out.reason}.`, { field: at })
  }
}

export function planEditContent(args: EditContentArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const c = args.collection
  const live = isSafeSlug(args.slug) ? readOne(c, args.slug) : null
  if (!live) return draftRefusal({ ok: false, code: 'NOT_FOUND', error: '' })
  const draft = isDraftFrontmatter(live.frontmatter)
  const pendingRow = getPendingRevision(c, args.slug)
  const view = !draft && pendingRow ? pendingRow : live

  let body = args.body
  if (args.edits) {
    const out = applyEdits(view.body ?? '', args.edits)
    if (!out.ok) return editsRefusal(out)
    body = out.body
  }
  // The held check is the caller's (§4.6): the plan reports it, lib/ai/execute decides.
  const prepared = prepareDraftEdit(
    c,
    { slug: args.slug, baseVersion: args.base_version, body, frontmatterPatch: args.frontmatter_patch ? plain(args.frontmatter_patch) : undefined, removeFrontmatter: args.remove_frontmatter },
    { allowHeld: true, now: ctx.now },
  )
  if (!prepared.ok) return draftRefusal(prepared)
  if (!prepared.changed) return refuse('NO_VISIBLE_CHANGE', 'The change leaves the item exactly as it is. Nothing was saved.')

  const held = heldReason(c, args.slug, ctx.now)
  const pending = prepared.target === 'pending'
  const before: BeforeState = {
    kind: 'item',
    collection: c,
    slug: args.slug,
    live: { frontmatter: prepared.live.frontmatter, body: prepared.live.body, updatedAt: prepared.live.updatedAt },
    pending: prepared.pendingRow
      ? { frontmatter: prepared.pendingRow.frontmatter, body: prepared.pendingRow.body, updatedAt: prepared.pendingRow.updatedAt, baseUpdatedAt: prepared.pendingRow.baseUpdatedAt }
      : null,
  }
  const kind = pending ? 'item.edit-pending' : 'item.edit-draft'
  const touchedKeys = [...Object.keys(args.frontmatter_patch ?? {}), ...(args.remove_frontmatter ?? [])]
  return {
    kind,
    risk: 'draft',
    target: { kind: c, ref: args.slug },
    baseVersion: prepared.version,
    args: {
      collection: c,
      slug: args.slug,
      base_version: prepared.version,
      // The body the edits resolved to: what the write stores, and what an approval would execute.
      body: prepared.body,
      ...(args.frontmatter_patch ? { frontmatter_patch: plain(args.frontmatter_patch) } : {}),
      ...(args.remove_frontmatter ? { remove_frontmatter: [...args.remove_frontmatter] } : {}),
    },
    rationale: args.rationale ?? null,
    before,
    preview: {
      kind,
      risk: 'draft',
      title: pending ? `Unpublished changes to ${noun(c)} ${args.slug}` : `Edit of draft ${noun(c)} ${args.slug}`,
      documents: [
        {
          ref: `${c}/${args.slug}`,
          label: pending ? `Unpublished changes of ${noun(c)} ${args.slug}` : `Draft ${noun(c)} ${args.slug}`,
          publicUrl: draft ? null : `/${c}/${args.slug}`,
          format: 'mdx',
          before: documentText(prepared.shown.frontmatter, prepared.shown.body),
          after: documentText(prepared.frontmatter, prepared.body),
        },
      ],
      effects: { publicPaths: [], schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    held: held ? (held.code === 'ITEM_SCHEDULED' ? { reason: 'scheduled', publishAt: held.publishAt } : { reason: 'review_link', activeLinks: held.activeLinks }) : null,
    check: { kind: 'item', collection: c, touchedKeys, frontmatter: prepared.frontmatter, body: prepared.body, before: prepared.shown },
    audit: {
      route: ROUTE[c],
      method: 'PUT',
      body: pending ? { slug: args.slug, frontmatter: prepared.frontmatter, target: 'pending' } : { slug: args.slug, frontmatter: prepared.frontmatter },
    },
    editUrl: editUrl(c, args.slug),
  }
}
