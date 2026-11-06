/**
 * Find-and-replace edits of an AI write (pure, design §4.2 `edit_content`,
 * §4.5 caps).
 *
 * Every edit must match: a miss is EDIT_NOT_FOUND (with the failing
 * `find`), more than one match without `all` is EDIT_AMBIGUOUS, and nothing
 * is applied either way. Edits apply in order, each to the result of the
 * one before.
 *
 * The caps hold BEFORE any string is built. One small call could otherwise
 * end the process: forty edits of `{ find: 'a', replace: 'aa', all: true }`
 * double the body forty times, and no `try` catches running out of heap. So
 * matches are counted with an `indexOf` loop that stops past the limit, and
 * the size the body would have is computed arithmetically —
 * `bytes + matches × (bytes(replace) − bytes(find))` — and refused before
 * the new body exists. The final size is checked once more.
 *
 * Sizes are UTF-8 bytes. Only well-formed text is accepted (no lone
 * surrogate in the body, `find` or `replace`), so a match never splits a
 * character and the arithmetic is exact.
 */

export const EDIT_LIMITS = Object.freeze({
  /** Edits in one call (also the Zod limit). */
  edits: 50,
  /** Matches of one edit. */
  matchesPerEdit: 1000,
  /** The body after the edits, in UTF-8 bytes. */
  bodyBytes: 256 * 1024,
})

export type TextEdit = { find: string; replace: string; all?: boolean }

export type EditsOutcome =
  | { ok: true; body: string; matches: number }
  | { ok: false; code: 'EDIT_NOT_FOUND'; index: number; find: string }
  | { ok: false; code: 'EDIT_AMBIGUOUS'; index: number; find: string; matches: number }
  | { ok: false; code: 'EDIT_TOO_LARGE'; index: number | null; reason: 'matches' | 'size' }
  | { ok: false; code: 'INVALID_INPUT'; index: number | null; reason: string }

export const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8')

/** Text without lone surrogates (String.prototype.isWellFormed). */
export function isWellFormed(s: string): boolean {
  return (s as string & { isWellFormed(): boolean }).isWellFormed()
}

/** Non-overlapping match positions of `find` in `text`, left to right, at most `cap` of them. */
function matchPositions(text: string, find: string, cap: number): number[] {
  const out: number[] = []
  let from = 0
  while (out.length < cap) {
    const at = text.indexOf(find, from)
    if (at < 0) break
    out.push(at)
    from = at + find.length
  }
  return out
}

/** Apply `edits` to `body` in order, or say which edit could not be applied and why. Never builds an oversized string. */
export function applyEdits(body: string, edits: readonly TextEdit[], limits: { matchesPerEdit?: number; bodyBytes?: number } = {}): EditsOutcome {
  const maxMatches = limits.matchesPerEdit ?? EDIT_LIMITS.matchesPerEdit
  const maxBytes = limits.bodyBytes ?? EDIT_LIMITS.bodyBytes
  if (!isWellFormed(body)) return { ok: false, code: 'INVALID_INPUT', index: null, reason: 'The stored text is not well-formed Unicode' }
  let text = body
  let bytes = utf8Bytes(body)
  let total = 0
  for (let i = 0; i < edits.length; i++) {
    const { find, replace, all } = edits[i]
    if (typeof find !== 'string' || !find || typeof replace !== 'string') return { ok: false, code: 'INVALID_INPUT', index: i, reason: 'find must be non-empty text and replace text' }
    if (!isWellFormed(find) || !isWellFormed(replace)) return { ok: false, code: 'INVALID_INPUT', index: i, reason: 'find and replace must be well-formed Unicode (no lone surrogate)' }
    // One more than allowed tells "too many" from "exactly the limit"; two tell "ambiguous" from "unique".
    const positions = matchPositions(text, find, all ? maxMatches + 1 : 2)
    if (positions.length === 0) return { ok: false, code: 'EDIT_NOT_FOUND', index: i, find }
    if (!all && positions.length > 1) return { ok: false, code: 'EDIT_AMBIGUOUS', index: i, find, matches: positions.length }
    if (positions.length > maxMatches) return { ok: false, code: 'EDIT_TOO_LARGE', index: i, reason: 'matches' }
    const projected = bytes + positions.length * (utf8Bytes(replace) - utf8Bytes(find))
    if (projected > maxBytes) return { ok: false, code: 'EDIT_TOO_LARGE', index: i, reason: 'size' }
    const parts: string[] = []
    let from = 0
    for (const at of positions) {
      parts.push(text.slice(from, at), replace)
      from = at + find.length
    }
    parts.push(text.slice(from))
    text = parts.join('')
    bytes = projected
    total += positions.length
  }
  if (utf8Bytes(text) > maxBytes) return { ok: false, code: 'EDIT_TOO_LARGE', index: null, reason: 'size' }
  return { ok: true, body: text, matches: total }
}
