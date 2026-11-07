import { editorBaseText } from './editorBase'

/**
 * The editor bridge, browser side (design §7.8): what an open editor and an
 * AI suggestion for it exchange. Pure (no React), so tests/ai-editor-bridge
 * runs it as the browser does, Web Crypto included.
 *
 *   - An editor describes itself (its target, version, dirty flag and the
 *     document as it would save it) and sends that with a message: the run
 *     is attached to it, and a change to that document comes back as a
 *     suggestion instead of a write.
 *   - A suggestion is whole-text and hash-bound: "Apply to editor" runs only
 *     while the editor's text still hashes to the suggestion's base hash
 *     (editorBase.editorBaseText). Then the body is replaced and the
 *     suggestion's fields are set or removed — nothing else in the form
 *     changes, `draft` and the schedule never among them.
 */

/** The document an editor would save: its frontmatter as the save sends it, and the body. */
export type EditorDoc = { frontmatter: Record<string, unknown>; body: string }

/** The document an editor is open on. */
export type EditorTarget = { kind: 'item'; collection: 'blog' | 'work'; slug: string } | { kind: 'page'; name: 'now' | 'uses' | 'about' | 'about-zh' }

/** What GET /api/admin/ai/changes/<id> answers as `editor` for a change an editor can take (lib/ai/changeViews editorPayloadOf). */
export type EditorPayload = {
  base_hash: string
  after_body: string
  frontmatter_patch: Record<string, unknown> | null
  remove_frontmatter: string[]
  keys: string[]
}

/** The chip ref of a target: `blog/<slug>`, `work/<slug>` or the page name (lib/ai/attachments). */
export const targetRef = (t: EditorTarget): string => (t.kind === 'item' ? `${t.collection}/${t.slug}` : t.name)

/** The change target (ai_changes target_kind / target_ref) of an editor target. */
export const changeTargetOf = (t: EditorTarget): { kind: string; ref: string } => (t.kind === 'item' ? { kind: t.collection, ref: t.slug } : { kind: 'page', ref: t.name })

/** Does a change's target name this editor's document? */
export function sameTarget(t: EditorTarget, change: { kind: string; ref: string }): boolean {
  const own = changeTargetOf(t)
  return own.kind === change.kind && own.ref === change.ref
}

/** What a target is called in the bridge's sentences. */
export const targetNoun = (t: EditorTarget): string => (t.kind === 'page' ? 'page' : t.collection === 'blog' ? 'post' : 'case study')

/** SHA-256 of UTF-8 text, hex (Web Crypto: in the browser, and in Node as globalThis.crypto). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The hash of an editor's text as a suggestion with these keys was bound to it. */
export const editorHash = (doc: EditorDoc, keys: readonly string[]): Promise<string> => sha256Hex(editorBaseText(doc, keys))

/** Does the editor still hold the text the suggestion was computed from? */
export async function canApply(doc: EditorDoc, payload: EditorPayload): Promise<boolean> {
  return (await editorHash(doc, payload.keys)) === payload.base_hash
}

/** The document after the suggestion: its body, and its fields set and removed; every other field as it is. */
export function applied(doc: EditorDoc, payload: EditorPayload): EditorDoc {
  const frontmatter: Record<string, unknown> = { ...doc.frontmatter }
  for (const [k, v] of Object.entries(payload.frontmatter_patch ?? {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    frontmatter[k] = v
  }
  for (const k of payload.remove_frontmatter) delete frontmatter[k]
  return { frontmatter, body: payload.after_body }
}

/** Is the editor still exactly at a document (Undo of an apply is offered only then)? */
export async function sameDoc(a: EditorDoc, b: EditorDoc): Promise<boolean> {
  const keys = Array.from(new Set([...Object.keys(a.frontmatter), ...Object.keys(b.frontmatter)]))
  return (await editorHash(a, keys)) === (await editorHash(b, keys))
}

/** Only these change ids are sent anywhere (lib/ai/apply CHANGE_ID_RE). */
export const CHANGE_ID_RE = /^ch_[a-z2-7]{16}$/

/**
 * Tell the server the editor saved a version carrying these changes (POST changes/<id>/editor-saved). Each is
 * attributed on its own; a refusal (the change expired, the document moved on) loses only that attribution, never
 * the save. Resolves to the ids that were attributed.
 */
export async function reportEditorSaved(ids: readonly string[], version: string | null): Promise<string[]> {
  if (!version) return []
  const done: string[] = []
  for (const id of ids) {
    if (!CHANGE_ID_RE.test(id)) continue
    try {
      const res = await fetch(`/api/admin/ai/changes/${id}/editor-saved`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ version }),
      })
      if (res.ok) done.push(id)
    } catch {
      // Attribution only: the save itself already stands.
    }
  }
  return done
}
