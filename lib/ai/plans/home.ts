import { kvEtag } from '../../contentStore'
import { normalizeHomeWrite, publicHome, readHomeWithVersion, type HomeData } from '../../home'
import { visibleHighlights } from '../../homeSections'
import { isHomePayload } from '../../homePayload'
import { HOME_PAGE_PATHS } from '../../revalidate'
import { HOME_EDIT_PATHS, HOME_REFUSED } from '../allowLists'
import { LINK_RULES, printedLinks } from '../lint'
import type { ToolContext, ToolRefusal } from '../toolTypes'
import { hasUnsafeKey, needsDraftAccess, prettyJson, refuse, stringLeaves, versionProblem } from './common'
import { canonicalJson, type WritePlan } from './types'

/**
 * Plan of `propose_home_edit` (pure, design §4.2, §4.3, §5.7): a list of
 * `{ path, value_json }` operations on the home page.
 *
 * The model reads the public view (get_home), so every array position it
 * names is a position in that view: hidden photos, switched-off sections and
 * incomplete highlights are not there. The plan walks the same filters,
 * translates each public position to the stored one and stores it with the
 * photo's address (the card names it); a position outside the public view
 * answers NOT_FOUND exactly like one past the end. At approval the same
 * translation runs again: a photo hidden or moved meanwhile is a conflict.
 *
 * The ops are applied to the stored document as read, before any save
 * normaliser; every changed path must lie under a path an op targeted, so
 * nothing outside what the ops name — hidden photos, switched-off sections —
 * changes. The preview is the public view before and after the save's own
 * normaliser (lib/homeShape normalizeHomeWrite), and an empty public diff
 * is refused (NO_VISIBLE_CHANGE): the owner is never offered a change the
 * card cannot show.
 */

export type HomeOp = { path: string; value_json: string; stored_path?: string; photo_url?: string }
/**
 * `stamped_at` is never sent by a caller (the tool's schema is strict): when
 * the stored availability carries no time yet, the normaliser stamps one (as
 * the editor does on a save), and the proposal keeps the moment it stamped,
 * so the approval's re-plan shows — and writes — exactly what the card did.
 */
export type HomeEditArgs = { ops: HomeOp[]; base_version: string; rationale?: string; stamped_at?: number }

type Seg = string | number

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,4}\])*$/
const MAX_DEPTH = 8
/** The merged document's cap (§4.5). */
export const HOME_DOC_MAX_BYTES = 2 * 1024 * 1024

export function parsePath(path: string): Seg[] | null {
  if (!PATH_RE.test(path)) return null
  const segs: Seg[] = []
  for (const m of path.matchAll(/([A-Za-z_][A-Za-z0-9_]*)|\[(\d{1,4})\]/g)) segs.push(m[1] !== undefined ? m[1] : Number(m[2]))
  return segs.length > MAX_DEPTH ? null : segs
}

export const pathText = (segs: readonly Seg[]) => segs.map((s, i) => (typeof s === 'number' ? `[${s}]` : i === 0 ? s : `.${s}`)).join('')
/** The path with every index written `[n]`: what the allow-lists name. */
const pathShape = (segs: readonly Seg[]) => segs.map((s, i) => (typeof s === 'number' ? '[n]' : i === 0 ? s : `.${s}`)).join('')

const shapeRegex = (pattern: string) => {
  const wild = pattern.endsWith('.*')
  const base = (wild ? pattern.slice(0, -2) : pattern).replace(/\./g, '\\.').replace(/\[n\]/g, '\\[n\\]')
  return new RegExp(`^${base}${wild ? '(?:\\..+|\\[n\\].*)' : ''}$`)
}
const ALLOWED = HOME_EDIT_PATHS.map(shapeRegex)
const isRefused = (shape: string) => HOME_REFUSED.some((r) => shape === r || shape.startsWith(`${r}.`) || shape.startsWith(`${r}[`))

/** Text fields: a string value. */
const STRING_SHAPES = [
  /^hero\.(welcome|brand|tagline|tagline_zh)$/,
  /^hero\.currentlyCoding\.(label|project|note|label_zh|project_zh|note_zh)$/,
  /^quickAccess\[n\]\.(label|url)$/,
  /^photos\[n\]\.(describe|describe_zh|redirectTo)$/,
  /^highlights\[n\]\.(value|label|href|value_zh|label_zh)$/,
  /^contact\.(heading|blurb|eyebrow|heading_zh|blurb_zh|eyebrow_zh)$/,
  /^socials\.(github|gitlab|linkedin)$/,
]

/** Is `value` a valid value for a path of this shape? (Availability, open source and the site are checked by the save's normaliser.) */
function valueProblem(shape: string, value: unknown): string | null {
  const isStr = (v: unknown) => typeof v === 'string'
  const isStrMap = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every(isStr)
  if (STRING_SHAPES.some((re) => re.test(shape))) return isStr(value) ? null : 'a JSON string, for example "New text"'
  if (shape === 'contact.reasons') return Array.isArray(value) && value.every(isStr) ? null : 'a JSON array of strings'
  if (shape === 'contact.intents' || shape === 'contact.reasons_zh') return isStrMap(value) ? null : 'a JSON object of strings, keyed by reason'
  if (shape === 'quickAccess') {
    const ok = Array.isArray(value) && value.every((q) => isStrMap(q) && Object.keys(q).every((k) => k === 'label' || k === 'url') && isStr((q as any).label) && isStr((q as any).url))
    return ok ? null : 'a JSON array of { "label": string, "url": string }'
  }
  if (shape === 'highlights') {
    const keys = new Set(['value', 'label', 'href', 'value_zh', 'label_zh'])
    const ok = Array.isArray(value) && value.every((h) => isStrMap(h) && Object.keys(h).every((k) => keys.has(k)))
    return ok ? null : 'a JSON array of { "value", "label", "href", "value_zh"?, "label_zh"? } (strings)'
  }
  return null
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Stored positions of the photos the public view shows, in its order. */
function publicPhotoIndices(home: HomeData): number[] {
  if (home.sections?.photos === false || !Array.isArray(home.photos)) return []
  return home.photos.flatMap((p, i) => (p && p.visible !== false ? [i] : []))
}

/** Stored positions of the highlights the public view shows (complete tiles, at most the cap), in its order. */
function publicHighlightIndices(home: HomeData): number[] {
  if (home.sections?.highlights === false || !Array.isArray(home.highlights)) return []
  const out: number[] = []
  const max = visibleHighlights(home.highlights).length
  home.highlights.forEach((h, i) => {
    if (out.length < max && visibleHighlights([h]).length === 1) out.push(i)
  })
  return out
}

function setAt(root: Record<string, any>, segs: readonly Seg[], value: unknown): boolean {
  let cur: any = root
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    const next = segs[i + 1]
    if (cur[seg] === undefined || cur[seg] === null) {
      if (typeof seg === 'number') return false
      cur[seg] = typeof next === 'number' ? [] : {}
    }
    cur = cur[seg]
    if (!cur || typeof cur !== 'object') return false
  }
  const last = segs[segs.length - 1]
  if (Array.isArray(cur) && (typeof last !== 'number' || last >= cur.length)) return false
  if (!Array.isArray(cur) && typeof last === 'number') return false
  cur[last] = value
  return true
}

/** Paths at which `a` and `b` differ (an array of another length differs as a whole). */
export function changedPaths(a: unknown, b: unknown, at: Seg[] = [], out: Seg[][] = []): Seg[][] {
  if (canonicalJson(a) === canonicalJson(b)) return out
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((v, i) => changedPaths(v, b[i], [...at, i], out))
    return out
  }
  const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) changedPaths((a as any)[k], (b as any)[k], [...at, k], out)
    return out
  }
  out.push(at)
  return out
}

const under = (path: readonly Seg[], target: readonly Seg[]) => target.length <= path.length && target.every((s, i) => path[i] === s)

const LINK_KEYS = new Set(['url', 'href', 'redirectTo', 'bookingUrl', 'github', 'gitlab', 'linkedin'])

/** Link targets in a public home view, as the site prints them. */
export function homeLinks(view: unknown): string[] {
  const out: string[] = []
  const visit = (v: unknown, key: string | null, depth: number) => {
    if (depth > 16) return
    if (typeof v === 'string') {
      if (key && LINK_KEYS.has(key)) out.push(...printedLinks(v, LINK_RULES.href))
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, key, depth + 1))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1)
  }
  visit(view, null, 0)
  return out
}

const notFound = (path: string): ToolRefusal => refuse('NOT_FOUND', `${path}: nothing is at that position of the home page (read it again with get_home).`, { field: path })

export function planHomeEdit(args: HomeEditArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  const { home: stored, version } = readHomeWithVersion()
  const current = kvEtag(version)
  const stale = versionProblem(args.base_version, current, 'The home page')
  if (stale) return stale
  if (!stored || !isHomePayload(stored)) return refuse('NOT_FOUND', 'The home page has no stored document yet. Ask the owner to set it up in the Home editor.')

  const photos = publicPhotoIndices(stored)
  const highlights = publicHighlightIndices(stored)
  const merged = clone(stored) as unknown as Record<string, any>
  const targets: Seg[][] = []
  const ops: HomeOp[] = []
  const photoUrls: string[] = []
  for (const [i, op] of args.ops.entries()) {
    const field = `ops[${i}].path`
    const segs = parsePath(op.path)
    if (!segs) return refuse('INVALID_INPUT', `${field}: a path such as hero.tagline, quickAccess[0].label or photos[1].describe.`, { field })
    const shape = pathShape(segs)
    if (isRefused(shape) || !ALLOWED.some((re) => re.test(shape))) {
      return refuse('FIELD_NOT_EDITABLE', `${op.path} is not a part of the home page a proposal may set (see get_authoring_guide topic home).`, { field: op.path })
    }
    let value: unknown
    try {
      value = JSON.parse(op.value_json)
    } catch {
      return refuse('INVALID_INPUT', `ops[${i}].value_json: not valid JSON. Send a JSON string ("text") or array ([...]).`, { field: `ops[${i}].value_json` })
    }
    if (hasUnsafeKey(value)) return refuse('INVALID_INPUT', `ops[${i}].value_json: keys such as __proto__ are not allowed.`, { field: `ops[${i}].value_json` })
    const problem = valueProblem(shape, value)
    if (problem) return refuse('INVALID_INPUT', `ops[${i}].value_json: ${op.path} takes ${problem}.`, { field: `ops[${i}].value_json` })

    // Public positions to stored ones.
    const storedSegs = [...segs]
    let photoUrl: string | undefined
    if (segs[0] === 'photos' && typeof segs[1] === 'number') {
      const at = photos[segs[1]]
      if (at === undefined) return notFound(op.path)
      storedSegs[1] = at
      photoUrl = String(stored.photos?.[at]?.url ?? '')
      photoUrls.push(photoUrl)
    } else if (segs[0] === 'highlights' && typeof segs[1] === 'number') {
      const at = highlights[segs[1]]
      if (at === undefined) return notFound(op.path)
      storedSegs[1] = at
    } else if (segs[0] === 'highlights' && segs.length === 1) {
      if (stored.sections?.highlights === false || highlights.length !== (stored.highlights?.length ?? 0)) {
        return refuse('FIELD_HAS_HIDDEN_ITEMS', 'highlights: some stored highlights are not shown, so the whole list cannot be replaced. Change one highlight at a time (highlights[n].…).', { field: op.path })
      }
    } else if (segs[0] === 'quickAccess' && typeof segs[1] === 'number') {
      if (segs[1] >= (stored.quickAccess?.length ?? 0)) return notFound(op.path)
    }
    const storedPath = pathText(storedSegs)
    // At approval the same translation must come out: a photo hidden or moved meanwhile is a conflict.
    if ((op.stored_path !== undefined && op.stored_path !== storedPath) || (op.photo_url !== undefined && op.photo_url !== photoUrl)) {
      return refuse('VERSION_CONFLICT', `${op.path} now points at another part of the home page than when it was proposed.`, { field: op.path })
    }
    if (!setAt(merged, storedSegs, value)) return notFound(op.path)
    targets.push(storedSegs)
    ops.push({ path: op.path, value_json: op.value_json, stored_path: storedPath, ...(photoUrl !== undefined ? { photo_url: photoUrl } : {}) })
  }

  // Nothing outside what the ops name changed (hidden photos, switched-off sections stay byte for byte).
  for (const p of changedPaths(stored, merged)) {
    if (!targets.some((t) => under(p, t))) return refuse('INVALID_INPUT', `The change would touch ${pathText(p)}, which no operation names.`)
  }
  if (!isHomePayload(merged)) return refuse('INVALID_HOME', 'The home page would lose its required parts.')
  const storedAvailability = (stored as { availability?: { updatedAt?: unknown } }).availability
  const stamps = !!storedAvailability && typeof storedAvailability === 'object' && typeof storedAvailability.updatedAt !== 'number'
  const stampedAt = typeof args.stamped_at === 'number' && Number.isSafeInteger(args.stamped_at) && args.stamped_at > 0 ? args.stamped_at : Math.trunc(ctx.now)
  const normalized = normalizeHomeWrite(merged as HomeData, stampedAt)
  if (!normalized.ok) {
    return refuse('INVALID_HOME', `${normalized.errors[0]?.path ?? 'home'}: ${normalized.errors[0]?.message ?? 'invalid value'}`, { errors: normalized.errors.slice(0, 5) })
  }
  if (Buffer.byteLength(JSON.stringify(normalized.home), 'utf8') > HOME_DOC_MAX_BYTES) return refuse('EDIT_TOO_LARGE', 'The home document would be larger than 2 MB.')
  const viewBefore = publicHome(stored)
  const viewAfter = publicHome(normalized.home)
  if (canonicalJson(viewBefore) === canonicalJson(viewAfter)) return refuse('NO_VISIBLE_CHANGE', 'The change would not change anything visitors see on the home page.')

  return {
    kind: 'home.edit',
    risk: 'live',
    proposal: true,
    target: { kind: 'home', ref: 'home' },
    baseVersion: current,
    args: { ops, base_version: current, ...(stamps ? { stamped_at: stampedAt } : {}) },
    rationale: args.rationale ?? null,
    before: { kind: 'doc', doc: 'home', value: stored, version },
    preview: {
      kind: 'home.edit',
      risk: 'live',
      title: 'Edit the home page',
      documents: [
        {
          ref: 'home',
          label: photoUrls.length ? `Home page as visitors see it; photos ${photoUrls.join(', ')}` : 'Home page as visitors see it',
          publicUrl: '/',
          format: 'json',
          before: prettyJson(viewBefore),
          after: prettyJson(viewAfter),
        },
      ],
      effects: { publicPaths: [...HOME_PAGE_PATHS], schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    held: null,
    check: {
      kind: 'documents',
      documents: [
        {
          format: 'json',
          strings: stringLeaves(normalized.home),
          beforeStrings: stringLeaves(stored),
          links: homeLinks(viewAfter),
          beforeLinks: homeLinks(viewBefore),
          images: [],
          beforeImages: [],
          rewritten: true,
        },
      ],
    },
    audit: { route: 'home', method: 'PUT', body: {} },
    exec: { doc: normalized.home },
    editUrl: '/admin/home',
  }
}
