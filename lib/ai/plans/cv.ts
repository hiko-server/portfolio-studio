import { kvEtag, publishedItemSlugs } from '../../contentStore'
import { readCvDataWithVersion, type FullCvDoc } from '../../cvdata'
import { uidListKeys, withEntryUids } from '../../cvEntryUid'
import { SECTION_BY_NAME, type FieldDef, type ListDef } from '../../cvSections'
import { validateCvDoc } from '../../cvValidate'
import {
  HIDDEN_ITEM_MARK,
  VISIBILITY_KEYS,
  fieldShownIn,
  hiddenIndices,
  isFieldHidden,
  publicCvDoc,
  publicSections,
  withPublishedCaseStudies,
  type CvDoc,
} from '../../cvVisibility'
import { CV_PAGE_PATHS } from '../../revalidate'
import { CV_DENIED_KEYS } from '../allowLists'
import { LINK_RULES, printedLinks } from '../lint'
import type { ToolContext, ToolRefusal } from '../toolTypes'
import { AI_CV_STRIP } from '../views'
import { hasUnsafeKey, needsDraftAccess, prettyJson, refuse, stringLeaves, versionProblem } from './common'
import { canonicalJson, type WritePlan } from './types'

/**
 * Plan of `propose_cv_edit` (pure, design §4.4, §5.7): patches of the CV —
 * `set_field`, `add_entry`, `remove_entry` — never the whole document,
 * which the model cannot read (get_cv serves the public view only).
 *
 *   - Every target resolves in the public view, now and again at approval:
 *     the section is shown on the website, the entry's uid is in the view.
 *     A hidden entry answers exactly like an unknown uid (an entry stored
 *     without a uid gets a predictable one, and a uid seen earlier stays
 *     valid after the owner hides that entry).
 *   - A field must be in the registry for that section (lib/cvSections) and
 *     outside the deny-list (visibility and audience keys, consent, the PDF
 *     photo, editor bookkeeping, uids, the ORCID marker, the contact fields
 *     no tool reads), at any depth of the value. A field the owner hid is
 *     FIELD_NOT_EDITABLE; a list with hidden or audience-limited items is
 *     FIELD_HAS_HIDDEN_ITEMS (writing it back would drop the hidden items or
 *     store the hidden-author mark over a name).
 *   - The ops are applied to the stored document as read, and only what
 *     they name may differ afterwards; the public views before and after
 *     must differ (NO_VISIBLE_CHANGE otherwise), and the result must pass
 *     the registry check the save runs (INVALID_CV).
 */

export const CV_OPS = ['set_field', 'add_entry', 'remove_entry'] as const
export type CvOp = { op: (typeof CV_OPS)[number]; lang: 'en' | 'zh'; section: string; uid?: string; field?: string; value_json?: string }
export type CvEditArgs = { ops: CvOp[]; base_version: string; rationale?: string }

export const CV_DOC_MAX_BYTES = 2 * 1024 * 1024
const ORCID_ID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/

type Section = Record<string, any>
type Target = { lang: 'en' | 'zh'; section: number; key?: string; list?: string; uid?: string; added?: boolean }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The CV as visitors see it on the website (lib/cvdata readPublicCvData's view of a given document). */
export function cvPublicView(doc: FullCvDoc): CvDoc {
  const view = publicCvDoc(doc, 'any', 'web')
  let published: Set<string>
  try {
    published = publishedItemSlugs('work')
  } catch {
    published = new Set()
  }
  return { en: withPublishedCaseStudies(view.en, published), zh: withPublishedCaseStudies(view.zh, published) }
}

const NOT_FOUND = (op: CvOp, i: number): ToolRefusal =>
  refuse('NOT_FOUND', `ops[${i}]: nothing with that section${op.uid ? ' and uid' : ''} is in the public CV (read it again with get_cv).`, { field: `ops[${i}]` })

/** Keys no proposal may write in `section`, at any depth. */
function deniedKeys(section: string): Set<string> {
  return new Set([...CV_DENIED_KEYS, ...(AI_CV_STRIP[section] ?? [])])
}

/** The first problem of a value for a field or nested list of the registry; null when it fits. */
function valueProblem(value: unknown, def: { field?: FieldDef; list?: ListDef }, denied: ReadonlySet<string>, depth = 0): string | null {
  if (depth > 6) return 'too deeply nested'
  if (def.list) {
    if (!Array.isArray(value)) return 'a JSON array of objects'
    for (const item of value) {
      if (!isObj(item)) return 'a JSON array of objects'
      const problem = entryProblem(item, def.list, denied, depth + 1)
      if (problem) return problem
    }
    return null
  }
  const f = def.field as FieldDef
  switch (f.kind) {
    case 'bullets':
    case 'tags':
      return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : 'a JSON array of strings'
    case 'switch':
      return typeof value === 'boolean' ? null : 'true or false'
    case 'select':
      if (typeof value !== 'string') return 'a JSON string'
      return value === '' || (f.options ?? []).some((o) => o.value === value) ? null : `one of ${(f.options ?? []).map((o) => JSON.stringify(o.value)).join(', ')}`
    default:
      if (typeof value !== 'string') return 'a JSON string'
      if (f.key === 'orcid' && value !== '' && !ORCID_ID_RE.test(value)) return 'the bare ORCID iD, for example 0000-0002-1825-0097'
      return null
  }
}

/** The first problem of an entry object for a list of the registry. */
function entryProblem(item: Record<string, unknown>, list: ListDef, denied: ReadonlySet<string>, depth: number): string | null {
  for (const [k, v] of Object.entries(item)) {
    if (denied.has(k)) return `${k} is not a field a proposal may set`
    const field = list.fields.find((f) => f.key === k)
    const nested = (list.lists ?? []).find((l) => l.key === k)
    if (!field && !nested) return `${k} is not a field of this list`
    const problem = valueProblem(v, field ? { field } : { list: nested }, denied, depth + 1)
    if (problem) return `${k}: ${problem}`
  }
  return null
}

/** Any nested node of a stored value that carries a visibility or audience key. */
function hasVisibilityKeys(value: unknown, depth = 0): boolean {
  if (depth > 16 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((v) => hasVisibilityKeys(v, depth + 1))
  return Object.keys(value).some((k) => (VISIBILITY_KEYS as readonly string[]).includes(k)) || Object.values(value).some((v) => hasVisibilityKeys(v, depth + 1))
}

/** Any text leaf that is exactly the hidden-item mark (the public view's stand-in for a hidden author). */
const hasHiddenMark = (value: unknown) => stringLeaves(value).some((s) => s.trim() === HIDDEN_ITEM_MARK)

/** The list key and position of the entry with `uid` in a section's top-level lists. */
function entryAt(section: Section, uid: string): { list: string; index: number } | null {
  for (const list of uidListKeys(section.sessionName)) {
    const entries = section[list]
    if (!Array.isArray(entries)) continue
    const index = entries.findIndex((e) => isObj(e) && e.uid === uid)
    if (index >= 0) return { list, index }
  }
  return null
}

/** Is the entry with `uid` in the public view of the section? */
function entryPublic(section: Section, list: string, uid: string): boolean {
  const view = publicSections([section], 'any', 'web', { keepUids: true })[0]
  return !!view && Array.isArray(view[list]) && view[list].some((e: unknown) => isObj(e) && e.uid === uid)
}

/** What differs between the stored and the merged document, entry by entry (uids), field by field. */
function changes(stored: FullCvDoc, merged: FullCvDoc): Target[] {
  const out: Target[] = []
  for (const lang of ['en', 'zh'] as const) {
    const a = stored[lang]
    const b = merged[lang]
    if (a.length !== b.length) {
      out.push({ lang, section: -1 })
      continue
    }
    a.forEach((sa: Section, i: number) => {
      const sb = b[i] as Section
      if (canonicalJson(sa) === canonicalJson(sb)) return
      const lists = new Set(uidListKeys(sa?.sessionName))
      for (const key of new Set([...Object.keys(sa ?? {}), ...Object.keys(sb ?? {})])) {
        if (canonicalJson(sa?.[key]) === canonicalJson(sb?.[key])) continue
        if (!lists.has(key) || !Array.isArray(sa?.[key]) || !Array.isArray(sb?.[key])) {
          out.push({ lang, section: i, key })
          continue
        }
        const before = new Map<string, unknown>(sa[key].filter(isObj).map((e: Record<string, any>) => [String(e.uid), e]))
        const after = new Map<string, unknown>(sb[key].filter(isObj).map((e: Record<string, any>) => [String(e.uid), e]))
        // Entries kept must keep their order.
        const keptA = sa[key].filter((e: any) => isObj(e) && after.has(String(e.uid))).map((e: any) => String(e.uid))
        const keptB = sb[key].filter((e: any) => isObj(e) && before.has(String(e.uid))).map((e: any) => String(e.uid))
        if (keptA.join('\n') !== keptB.join('\n')) out.push({ lang, section: i, key })
        for (const [uid, ea] of before) {
          const eb = after.get(uid)
          if (eb === undefined) out.push({ lang, section: i, list: key, uid })
          else if (canonicalJson(ea) !== canonicalJson(eb)) {
            for (const k of new Set([...Object.keys(ea as object), ...Object.keys(eb as object)])) {
              if (canonicalJson((ea as any)[k]) !== canonicalJson((eb as any)[k])) out.push({ lang, section: i, list: key, uid, key: k })
            }
          }
        }
        for (const e of sb[key]) if (!isObj(e) || e.uid === undefined || !before.has(String(e.uid))) out.push({ lang, section: i, list: key, added: true })
      }
    })
  }
  return out
}

const covers = (t: Target, c: Target) =>
  t.lang === c.lang &&
  t.section === c.section &&
  (t.added ? c.added === true && c.list === t.list : t.list ? c.list === t.list && c.uid === t.uid && (t.key === undefined || c.key === t.key) : c.list === undefined && c.key === t.key)

/** Link targets of a public CV view: its url fields, as the site prints them. */
export function cvLinks(view: CvDoc): string[] {
  const out: string[] = []
  const visitFields = (node: Record<string, any>, fields: readonly FieldDef[] | undefined, lists: readonly ListDef[] | undefined) => {
    for (const f of fields ?? []) if (f.kind === 'url' && typeof node[f.key] === 'string') out.push(...printedLinks(node[f.key], LINK_RULES.href))
    for (const l of lists ?? []) for (const item of Array.isArray(node[l.key]) ? node[l.key] : []) if (isObj(item)) visitFields(item, l.fields, l.lists)
  }
  for (const lang of ['en', 'zh'] as const) {
    for (const s of view[lang]) {
      const def = SECTION_BY_NAME[String(s.sessionName ?? '')]
      if (def) visitFields(s, def.fields, def.lists)
    }
  }
  return out
}

export function planCvEdit(args: CvEditArgs, ctx: ToolContext): WritePlan | ToolRefusal {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  const read = readCvDataWithVersion()
  const current = kvEtag(read.version)
  const stale = versionProblem(args.base_version, current, 'The CV')
  if (stale) return stale
  const stored: FullCvDoc = { en: read.en, zh: read.zh }
  const merged: FullCvDoc = clone(stored)
  const targets: Target[] = []

  for (const [i, op] of args.ops.entries()) {
    const sections = stored[op.lang]
    const sIdx = sections.findIndex((s: Section) => isObj(s) && s.sessionName === op.section)
    const def = SECTION_BY_NAME[op.section]
    if (sIdx < 0 || !def || publicSections([sections[sIdx]], 'any', 'web').length !== 1) return NOT_FOUND(op, i)
    const storedSection = sections[sIdx] as Section
    const mergedSection = merged[op.lang][sIdx] as Section
    const denied = deniedKeys(op.section)
    let value: unknown
    if (op.op !== 'remove_entry') {
      if (op.value_json === undefined) return refuse('INVALID_INPUT', `ops[${i}].value_json: required for ${op.op}.`, { field: `ops[${i}].value_json` })
      try {
        value = JSON.parse(op.value_json)
      } catch {
        return refuse('INVALID_INPUT', `ops[${i}].value_json: not valid JSON.`, { field: `ops[${i}].value_json` })
      }
      if (hasUnsafeKey(value)) return refuse('INVALID_INPUT', `ops[${i}].value_json: keys such as __proto__ are not allowed.`, { field: `ops[${i}].value_json` })
      if (hasHiddenMark(value)) return refuse('FIELD_HAS_HIDDEN_ITEMS', `ops[${i}].value_json: “${HIDDEN_ITEM_MARK}” stands for a hidden item in the public view and cannot be written.`, { field: `ops[${i}].value_json` })
    }

    if (op.op === 'set_field') {
      const field = op.field
      if (!field) return refuse('INVALID_INPUT', `ops[${i}].field: required for set_field.`, { field: `ops[${i}].field` })
      let node: Section
      let mergedNode: Section
      let target: Target
      let fieldDef: { field?: FieldDef; list?: ListDef }
      if (op.uid !== undefined) {
        const at = entryAt(storedSection, op.uid)
        if (!at || !entryPublic(storedSection, at.list, op.uid)) return NOT_FOUND(op, i)
        const listDef = (def.lists ?? []).find((l) => l.key === at.list) as ListDef
        const f = listDef.fields.find((x) => x.key === field)
        const nested = (listDef.lists ?? []).find((x) => x.key === field)
        if (denied.has(field) || (!f && !nested)) return refuse('FIELD_NOT_EDITABLE', `${field} is not a field of that entry a proposal may set (see get_authoring_guide topic cv).`, { field })
        node = storedSection[at.list][at.index]
        const mergedEntry = (mergedSection[at.list] as Section[]).find((e) => isObj(e) && e.uid === op.uid)
        if (!mergedEntry) return NOT_FOUND(op, i)
        mergedNode = mergedEntry
        target = { lang: op.lang, section: sIdx, list: at.list, uid: op.uid, key: field }
        fieldDef = f ? { field: f } : { list: nested }
      } else {
        const f = (def.fields ?? []).find((x) => x.key === field)
        if (denied.has(field) || !f) {
          return refuse('FIELD_NOT_EDITABLE', `${field} is not a field of section ${op.section} a proposal may set${def.lists?.length ? ' (entry fields need the entry’s uid)' : ''}.`, { field })
        }
        node = storedSection
        mergedNode = mergedSection
        target = { lang: op.lang, section: sIdx, key: field }
        fieldDef = { field: f }
      }
      if (isFieldHidden(node, field) || !fieldShownIn(node, field, 'web')) return refuse('FIELD_NOT_EDITABLE', `${field} is hidden on the website, so a proposal cannot change it.`, { field })
      // Items limited to some surfaces (itemsOnlyIn[field], or a map the reader cannot read) count as hidden ones.
      const audiences = node.itemsOnlyIn === undefined || node.itemsOnlyIn === null ? undefined : isObj(node.itemsOnlyIn) ? node.itemsOnlyIn[field] : false
      const limited = audiences !== undefined && audiences !== null && !(isObj(audiences) && Object.keys(audiences).length === 0)
      if (hiddenIndices(node, field).length || limited || hasVisibilityKeys(node[field])) {
        return refuse('FIELD_HAS_HIDDEN_ITEMS', `${field} has items the public view does not show, so it cannot be written as a whole.`, { field })
      }
      const problem = valueProblem(value, fieldDef, denied)
      if (problem) return refuse('INVALID_INPUT', `ops[${i}].value_json: ${field} takes ${problem}.`, { field: `ops[${i}].value_json` })
      mergedNode[field] = value
      targets.push(target)
      continue
    }

    const lists = uidListKeys(op.section)
    if (op.op === 'add_entry') {
      const list = op.field ?? (lists.length === 1 ? lists[0] : undefined)
      if (!list || !lists.includes(list)) {
        return refuse('INVALID_INPUT', lists.length ? `ops[${i}].field: name the list to add to (${lists.join(' or ')}).` : `ops[${i}]: section ${op.section} has no entries to add.`, { field: `ops[${i}].field` })
      }
      if (!isObj(value)) return refuse('INVALID_INPUT', `ops[${i}].value_json: a JSON object with the entry's fields.`, { field: `ops[${i}].value_json` })
      const listDef = (def.lists ?? []).find((l) => l.key === list) as ListDef
      // Visibility, audience and the uid are the server's: a new entry is plain and public, and gets its uid on save.
      const entry: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) if (!(VISIBILITY_KEYS as readonly string[]).includes(k) && k !== 'uid') entry[k] = v
      for (const k of Object.keys(entry)) if (denied.has(k)) return refuse('FIELD_NOT_EDITABLE', `${k} is not a field a proposal may set.`, { field: k })
      const problem = entryProblem(entry, listDef, denied, 0)
      if (problem) return refuse('INVALID_INPUT', `ops[${i}].value_json: ${problem}.`, { field: `ops[${i}].value_json` })
      if (!Array.isArray(mergedSection[list])) mergedSection[list] = []
      mergedSection[list].push({ ...listDef.blank(), ...entry })
      targets.push({ lang: op.lang, section: sIdx, list, added: true })
      continue
    }

    // remove_entry
    if (op.uid === undefined) return refuse('INVALID_INPUT', `ops[${i}].uid: required for remove_entry.`, { field: `ops[${i}].uid` })
    const at = entryAt(storedSection, op.uid)
    if (!at || !entryPublic(storedSection, at.list, op.uid)) return NOT_FOUND(op, i)
    const kept = (mergedSection[at.list] as Section[]).filter((e) => !(isObj(e) && e.uid === op.uid))
    if (kept.length === mergedSection[at.list].length) return NOT_FOUND(op, i)
    mergedSection[at.list] = kept
    targets.push({ lang: op.lang, section: sIdx, list: at.list, uid: op.uid })
  }

  // Only what the ops name changed: hidden entries, fields and sections stay byte for byte.
  for (const c of changes(stored, merged)) {
    if (!targets.some((t) => covers(t, c))) return refuse('INVALID_INPUT', 'The change would touch a part of the CV that no operation names.')
  }
  const filled = withEntryUids(merged)
  const touched = (lang: 'en' | 'zh') => canonicalJson(merged[lang]) !== canonicalJson(stored[lang])
  const checked = validateCvDoc({ en: touched('en') ? filled.en : undefined, zh: touched('zh') ? filled.zh : undefined })
  if (!checked.ok) {
    const e = checked.errors[0]
    return refuse('INVALID_CV', `${e?.message ?? 'invalid value'}`, { errors: checked.errors.slice(0, 5).map((x) => x.message) })
  }
  if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > CV_DOC_MAX_BYTES) return refuse('EDIT_TOO_LARGE', 'The CV would be larger than 2 MB.')
  const viewBefore = cvPublicView(stored)
  const viewAfter = cvPublicView(filled)
  if (canonicalJson(viewBefore) === canonicalJson(viewAfter)) return refuse('NO_VISIBLE_CHANGE', 'The change would not change anything visitors see on the CV.')

  return {
    kind: 'cv.edit',
    risk: 'live',
    proposal: true,
    target: { kind: 'cv', ref: 'cv' },
    baseVersion: current,
    args: { ops: args.ops.map((o) => ({ ...o })), base_version: current },
    rationale: args.rationale ?? null,
    before: { kind: 'doc', doc: 'cv', value: stored, version: read.version },
    preview: {
      kind: 'cv.edit',
      risk: 'live',
      title: 'Edit the CV',
      documents: [{ ref: 'cv', label: 'CV as visitors see it', publicUrl: '/cv', format: 'json', before: prettyJson(viewBefore), after: prettyJson(viewAfter) }],
      effects: { publicPaths: [...CV_PAGE_PATHS], schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    held: null,
    check: {
      kind: 'documents',
      documents: [
        { format: 'json', strings: stringLeaves(merged), beforeStrings: stringLeaves(stored), links: cvLinks(viewAfter), beforeLinks: cvLinks(viewBefore), images: [], beforeImages: [], rewritten: true },
      ],
    },
    audit: { route: 'cvdata', method: 'PUT', body: {} },
    exec: { doc: merged },
    editUrl: '/admin/dashboard?tab=cv',
  }
}
