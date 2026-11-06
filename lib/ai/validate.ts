import { FRONTMATTER_KEYS, FRONTMATTER_REFUSED } from './allowLists'
import { compileForAi, type CompileVerdict } from './compile'
import { EDIT_LIMITS, isWellFormed, utf8Bytes } from './edits'
import { bodyLinks, frontmatterImages, frontmatterLinks, misplacedInvisible, newExternalLinks, newPlayerEmbeds, newRemoteSources, zeroWidthCount, type InvisibleProblem, type NewLink } from './lint'
import type { AiWriteSubject } from './plans/types'
import type { ToolRefusal } from './toolTypes'

/**
 * validateAiWrite (SERVER-ONLY, design §4.5): the one check every AI write
 * passes before the code decides where it goes — applied at once, a waiting
 * change, or the open editor — so every path refuses the same things with
 * the same code. Nothing is written by the time it answers.
 *
 *   1. allow-lists: a frontmatter key outside §4.3 is FIELD_NOT_EDITABLE;
 *   2. invisible control characters the write adds, or carries from the
 *      owner's text into text of its own: INVISIBLE_CHARS;
 *   3. new remote images, in the body (every Markdown and MDX form, read by
 *      the real parser) or as a cover: REMOTE_IMAGE;
 *   4. new external links and player embeds: kept, listed for the owner —
 *      every link as the site prints it (a bare domain is an https link);
 *   5. the public MDX compile, in the limited worker (lib/ai/compile):
 *      MDX_INVALID with its position, MDX_TOO_COMPLEX, or CHECK_UNAVAILABLE
 *      when the check cannot run — never a fallback.
 *
 * The parse of steps 3 and 4 runs in the worker with the compile: a hostile
 * body never reaches the main thread's parser.
 */

export type ValidateOk = { ok: true; newLinks: NewLink[]; newEmbeds: string[]; zeroWidth: number }

const refuse = (code: ToolRefusal['code'], message: string, data?: Record<string, unknown>): ToolRefusal => ({ ok: false, code, message, ...(data ? { data } : {}) })

/** Every string inside `value` (keys excluded). */
function stringsOf(value: unknown, into: string[] = [], depth = 0): string[] {
  if (depth > 16) return into
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, into, depth + 1)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsOf(v, into, depth + 1)
  return into
}

const REMOTE_IMAGE_MESSAGE =
  'A remote image cannot be added: images must be uploads of this site, referenced as /uploads/<name> (see list_media). ' +
  'Importing a remote image into the uploads needs the owner’s approval.'

function invisibleRefusal(p: InvisibleProblem, what: string): ToolRefusal {
  const message = p.moved
    ? `${what} moves an invisible control character (${p.char}) the text already has, or rewrites the line it stands on. A line holding one must stay exactly as it is: leave that line unchanged.`
    : `${what} adds an invisible control character (${p.char}). Remove it.`
  return refuse('INVISIBLE_CHARS', message, { char: p.char, moved: p.moved })
}

function compileRefusal(v: Exclude<CompileVerdict, { ok: true }>): ToolRefusal {
  if (v.code === 'MDX_INVALID') {
    const where = v.line !== null ? `Line ${v.line}${v.column !== null ? `:${v.column}` : ''}: ` : ''
    return refuse('MDX_INVALID', `${where}${v.reason}`.slice(0, 600), { line: v.line, column: v.column })
  }
  if (v.code === 'MDX_TOO_COMPLEX') return refuse('MDX_TOO_COMPLEX', 'The body is too complex to check in time. Simplify its structure (fewer nested or unclosed constructs) and try again.')
  return refuse('CHECK_UNAVAILABLE', 'The site could not check this body just now, so nothing was saved. Try again in a minute.')
}

/** Check one AI write. `signal` abandons a check still waiting for the worker. */
export async function validateAiWrite(subject: AiWriteSubject, opts: { signal?: AbortSignal } = {}): Promise<ValidateOk | ToolRefusal> {
  if (subject.kind === 'texts') {
    const after = Object.values(subject.fields)
    if (!after.every(isWellFormed)) return refuse('INVALID_INPUT', 'Texts must be well-formed Unicode.')
    const misplaced = misplacedInvisible(after, Object.values(subject.before ?? {}))
    if (misplaced) return invisibleRefusal(misplaced, 'The change to these texts')
    return { ok: true, newLinks: [], newEmbeds: [], zeroWidth: Math.max(0, zeroWidthCount(after) - zeroWidthCount(Object.values(subject.before ?? {}))) }
  }

  // 1. Allow-lists (§4.3).
  const allowed = FRONTMATTER_KEYS[subject.collection]
  for (const key of subject.touchedKeys) {
    if (FRONTMATTER_REFUSED.includes(key)) {
      return refuse('FIELD_NOT_EDITABLE', `${key} cannot be set: publishing, scheduling and translation links are separate actions.`, { field: key })
    }
    if (!allowed.includes(key)) return refuse('FIELD_NOT_EDITABLE', `${key} is not a field of this collection that a change may set.`, { field: key })
  }
  if (utf8Bytes(subject.body) > EDIT_LIMITS.bodyBytes) return refuse('EDIT_TOO_LARGE', 'The body would be larger than 256 KiB.')
  if (!isWellFormed(subject.body)) return refuse('INVALID_INPUT', 'body: the text must be well-formed Unicode (no lone surrogate).', { field: 'body' })

  // 2. Invisible characters the write adds or misplaces, anywhere in the document.
  const afterTexts = [subject.body, ...stringsOf(subject.frontmatter)]
  const beforeTexts = subject.before ? [subject.before.body, ...stringsOf(subject.before.frontmatter)] : []
  const misplaced = misplacedInvisible(afterTexts, beforeTexts)
  if (misplaced) return invisibleRefusal(misplaced, 'The change')

  // 3a. A remote cover (no parse needed).
  const remoteCover = newRemoteSources(frontmatterImages(subject.frontmatter), frontmatterImages(subject.before?.frontmatter))
  if (remoteCover.length) return refuse('REMOTE_IMAGE', REMOTE_IMAGE_MESSAGE, { url: remoteCover[0], field: 'cover' })

  // 5 (with the parse of 3 and 4). The worker: real parse, then the public compile.
  const lang = typeof subject.frontmatter.lang === 'string' ? subject.frontmatter.lang : null
  const verdict = await compileForAi({ body: subject.body, before: subject.before?.body ?? null, lang }, { signal: opts.signal })
  if (!verdict.ok) return compileRefusal(verdict)

  // 3b. New remote images in the body.
  const remote = newRemoteSources(verdict.refs.images, verdict.beforeRefs.images)
  if (remote.length) return refuse('REMOTE_IMAGE', REMOTE_IMAGE_MESSAGE, { url: remote[0], count: remote.length })

  // 4. New links and embeds: kept, listed — each as the site prints it.
  return {
    ok: true,
    newLinks: newExternalLinks(
      [...bodyLinks(verdict.refs.links), ...frontmatterLinks(subject.frontmatter)],
      [...bodyLinks(verdict.beforeRefs.links), ...frontmatterLinks(subject.before?.frontmatter)],
    ),
    newEmbeds: newPlayerEmbeds(verdict.refs.embeds, verdict.beforeRefs.embeds),
    zeroWidth: Math.max(0, zeroWidthCount(afterTexts) - zeroWidthCount(beforeTexts)),
  }
}
