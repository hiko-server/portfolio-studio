/**
 * The text an editor suggestion is bound to (design §7.8), the same on both
 * sides: the server hashes it when it plans a suggestion for an open editor
 * (lib/ai/plans/editor) or offers a waiting proposal to the editor, and the
 * owner's browser hashes its editor's current state the same way before
 * "Apply to editor". The two hashes match only while the body, and every
 * field the suggestion sets or removes, are exactly what the suggestion was
 * computed from — otherwise nothing is applied ("The post changed while
 * this was being written. Ask again."). There is no partial apply: edits
 * put "where they still match" could assemble text the server never
 * checked, such as an image split across two edits.
 *
 * Pure and dependency-free: lib/ai imports it, and so does the admin's
 * editor bridge.
 */

/** What an editor may send as its state with a message (the AI write caps of §4.5, and a selection's length). */
export const EDITOR_STATE_LIMITS = Object.freeze({
  /** The body, in bytes of UTF-8 (an AI write's body cap). */
  bodyBytes: 256 * 1024,
  /** The frontmatter, as JSON, in bytes of UTF-8. */
  frontmatterBytes: 64 * 1024,
  /** How deep a frontmatter value may nest. */
  depth: 8,
  /** A selection, in characters. */
  selectionChars: 4000,
})

/** An empty value: no value, an empty string or an empty list (an editor writes these for a field it leaves empty). */
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

function canonical(v: unknown, depth: number): unknown {
  if (isEmpty(v) || depth > 16) return null
  if (Array.isArray(v)) return v.map((x) => canonical(x, depth + 1))
  if (typeof v === 'object') {
    const out: Array<[string, unknown]> = []
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (!isEmpty(x)) out.push([k, canonical(x, depth + 1)])
    }
    return out
  }
  return v
}

/**
 * The bound text of `doc` for a suggestion that sets or removes `keys`: the
 * body exactly, and each named field's value in a canonical form (sorted
 * keys; an empty value reads as no value).
 */
export function editorBaseText(doc: { frontmatter: Record<string, unknown>; body: string }, keys: readonly string[]): string {
  const fm = doc.frontmatter ?? {}
  const fields = Array.from(new Set(keys))
    .sort()
    .map((k) => [k, Object.prototype.hasOwnProperty.call(fm, k) ? canonical(fm[k], 0) : null])
  return JSON.stringify({ body: doc.body, fields })
}

/** Keys that would reach an object's prototype: never accepted in an editor's state. */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Whether `value` is plain JSON an editor could send as its frontmatter:
 * objects, lists, strings, finite numbers, booleans and null, no key that
 * reaches a prototype, at most `depth` levels deep.
 */
export function isPlainJson(value: unknown, depth: number = EDITOR_STATE_LIMITS.depth): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (depth <= 0) return false
  if (Array.isArray(value)) return value.every((v) => isPlainJson(v, depth - 1))
  if (typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.keys(value as Record<string, unknown>).every((k) => !UNSAFE_KEYS.has(k) && isPlainJson((value as Record<string, unknown>)[k], depth - 1))
}
