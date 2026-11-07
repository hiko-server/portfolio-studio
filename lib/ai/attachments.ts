import { EDITOR_STATE_LIMITS, isPlainJson } from '../../components/Admin/ai/editorBase'
import { isPageName, isSafeSlug } from '../mdx-admin'
import type { AttachmentRef } from './systemPrompt'
import type { EditorBinding } from './toolTypes'

/**
 * What a message to the assistant may carry besides its text (SERVER-ONLY,
 * design §7.8, PRODUCT §4.6): chips — typed references the server loads
 * itself (an item, a page, the home page, the CV, an image) — and, from an
 * open editor, two things a reference cannot say:
 *
 *   - the editor itself: the item or page the owner is editing, at the
 *     version it loaded, with `dirty` and its current form state. While the
 *     run is attached to it, get_content on that document reads this state
 *     and a change to it goes to the editor (lib/ai/plans/editor), never to
 *     the store. At most one per message.
 *   - a selection: text the owner selected there, quoted to the model as
 *     data with the message. At most one.
 *
 * Everything is checked here, before a run starts: sizes (the AI write caps
 * of §4.5), plain JSON frontmatter with no key that reaches a prototype, a
 * real slug or page name. A shape this server does not know is refused.
 */

export const ATTACH_MAX = 10
const ATTACH_KINDS = new Set(['item', 'page', 'home', 'cv', 'media', 'selection'])
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const VERSION_RE = /^[A-Za-z0-9"._:/-]{1,80}$/

export type Selection = { ref: string; text: string }

export type ParsedAttachments = {
  /** What the model is told and the conversation shows (never the editor's state or the selected text). */
  list: AttachmentRef[]
  editor: EditorBinding | null
  selection: Selection | null
}

const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const words = (s: string) => {
  const cjk = (s.match(/[㐀-鿿豈-﫿]/g) ?? []).length
  return cjk + s.replace(/[㐀-鿿豈-﫿]/g, ' ').split(/\s+/).filter(Boolean).length
}

/** `blog/<slug>` or `work/<slug>`: the post or case study an item chip names. */
export function itemRefOf(ref: string): { collection: 'blog' | 'work'; slug: string } | null {
  const m = /^(blog|work)\/(.+)$/.exec(ref)
  return m && isSafeSlug(m[2]) ? { collection: m[1] as 'blog' | 'work', slug: m[2] } : null
}

type Fail = { ok: false; error: string }

/** An editor's state: `{ frontmatter, body }`, plain JSON within the caps. */
function editorState(raw: unknown): { ok: true; state: { frontmatter: Record<string, unknown>; body: string } } | Fail {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'An editor’s state is { frontmatter, body }.' }
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) if (k !== 'frontmatter' && k !== 'body') return { ok: false, error: `An editor’s state has no ${k.slice(0, 40)}.` }
  if (typeof o.body !== 'string') return { ok: false, error: 'An editor’s body is text.' }
  if (utf8Bytes(o.body) > EDITOR_STATE_LIMITS.bodyBytes) return { ok: false, error: 'The body in the editor is larger than 256 KiB.' }
  const fm = o.frontmatter
  if (!fm || typeof fm !== 'object' || Array.isArray(fm) || !isPlainJson(fm)) return { ok: false, error: 'An editor’s frontmatter is plain JSON.' }
  if (utf8Bytes(JSON.stringify(fm)) > EDITOR_STATE_LIMITS.frontmatterBytes) return { ok: false, error: 'The editor’s fields are larger than 64 KiB.' }
  return { ok: true, state: { frontmatter: fm as Record<string, unknown>, body: o.body } }
}

/** Read the `attachments` of a message (undefined: none). */
export function parseAttachments(raw: unknown): ({ ok: true } & ParsedAttachments) | Fail {
  const out: ParsedAttachments = { list: [], editor: null, selection: null }
  if (raw === undefined) return { ok: true, ...out }
  if (!Array.isArray(raw) || raw.length > ATTACH_MAX) return { ok: false, error: `Attach at most ${ATTACH_MAX} items.` }
  for (const a of raw) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: 'An attachment is { kind, ref, version }.' }
    const o = a as Record<string, unknown>
    for (const k of Object.keys(o)) if (!['kind', 'ref', 'version', 'dirty', 'state'].includes(k)) return { ok: false, error: `This server does not take ${k.slice(0, 40)} on an attachment.` }
    if (typeof o.kind !== 'string' || !ATTACH_KINDS.has(o.kind)) return { ok: false, error: 'An attachment is an item, page, home, cv, media or selection.' }
    if (typeof o.ref !== 'string' || !REF_RE.test(o.ref)) return { ok: false, error: 'An attachment names a slug, page or file.' }
    if (o.version !== undefined && o.version !== null && (typeof o.version !== 'string' || !VERSION_RE.test(o.version))) return { ok: false, error: 'Not a version.' }
    if (o.dirty !== undefined && typeof o.dirty !== 'boolean') return { ok: false, error: 'dirty is true or false.' }
    const kind = o.kind as AttachmentRef['kind']
    const ref = o.ref
    const version = typeof o.version === 'string' ? o.version : null

    if (kind === 'selection') {
      if (out.selection) return { ok: false, error: 'Attach one selection at a time.' }
      if (o.dirty !== undefined) return { ok: false, error: 'A selection has no dirty flag.' }
      const st = o.state as Record<string, unknown> | undefined
      if (!st || typeof st !== 'object' || Array.isArray(st) || Object.keys(st).some((k) => k !== 'text') || typeof st.text !== 'string') return { ok: false, error: 'A selection is { kind, ref, state: { text } }.' }
      const text = st.text.trim()
      if (!text) return { ok: false, error: 'The selection is empty.' }
      if (text.length > EDITOR_STATE_LIMITS.selectionChars) return { ok: false, error: `Select at most ${EDITOR_STATE_LIMITS.selectionChars.toLocaleString('en')} characters.` }
      if (!itemRefOf(ref) && !isPageName(ref)) return { ok: false, error: 'A selection names the post, case study or page it is from.' }
      out.selection = { ref, text }
      out.list.push({ kind, ref, version: null, words: words(text) })
      continue
    }

    if (o.dirty !== undefined) {
      // The open editor (§7.8): its state comes with it, whether or not it has unsaved edits.
      if (kind !== 'item' && kind !== 'page') return { ok: false, error: 'Only a post, case study or page editor sends its state.' }
      if (out.editor) return { ok: false, error: 'A message comes from one editor.' }
      if (!version) return { ok: false, error: 'An editor names the version it loaded.' }
      const st = editorState(o.state)
      if (!st.ok) return st
      if (kind === 'item') {
        const item = itemRefOf(ref)
        if (!item) return { ok: false, error: 'An item editor names blog/<slug> or work/<slug>.' }
        out.editor = { kind: 'item', collection: item.collection, slug: item.slug, version, dirty: o.dirty as boolean, state: st.state }
      } else {
        if (!isPageName(ref)) return { ok: false, error: 'A page editor names now, uses, about or about-zh.' }
        out.editor = { kind: 'page', name: ref, version, dirty: o.dirty as boolean, state: st.state }
      }
      out.list.push({ kind, ref, version, dirty: o.dirty as boolean })
      continue
    }

    if (o.state !== undefined) return { ok: false, error: 'Only an open editor and a selection send their content.' }
    out.list.push({ kind, ref, version })
  }
  return { ok: true, ...out }
}
