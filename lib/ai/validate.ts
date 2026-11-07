import { FRONTMATTER_KEYS, FRONTMATTER_REFUSED } from './allowLists'
import { compileForAi, type CompileVerdict } from './compile'
import { EDIT_LIMITS, isWellFormed, utf8Bytes } from './edits'
import { bodyLinks, frontmatterImages, frontmatterLinks, linkFlags, misplacedInvisible, newExternalLinks, newPlayerEmbeds, newRemoteSources, readAddress, zeroWidthCount, type InvisibleProblem, type NewLink } from './lint'
import type { AiWriteSubject, CheckedDocument } from './plans/types'
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

/** New links of several documents, each address once (the first flags win: they are computed from the address alone). */
function mergeLinks(lists: readonly NewLink[][]): NewLink[] {
  const out = new Map<string, NewLink>()
  for (const list of lists) for (const l of list) if (!out.has(l.url)) out.set(l.url, l)
  return Array.from(out.values())
}

/**
 * The documents of a change that moves or rewrites stored text (§4.5 for
 * every AI write): text the server rewrote must compile and may add no
 * remote image and no misplaced invisible character; text that only moves
 * (a publish, a restore) is the owner's as stored. For both, every new
 * external link and player embed is listed, each body read by the real
 * parser in the worker.
 */
async function validateDocuments(subject: Extract<AiWriteSubject, { kind: 'documents' }>, opts: { signal?: AbortSignal }): Promise<ValidateOk | ToolRefusal> {
  const links: NewLink[][] = []
  const embeds = new Set<string>()
  let zeroWidth = 0
  for (const doc of subject.documents) {
    const out = await validateDocument(doc, opts)
    if (!out.ok) return out
    links.push(out.newLinks)
    out.newEmbeds.forEach((e) => embeds.add(e))
    zeroWidth += out.zeroWidth
  }
  const extra = (subject.extraLinks ?? []).map((raw) => {
    const read = readAddress(raw)
    return { url: read.url, flags: linkFlags(raw) }
  })
  return { ok: true, newLinks: mergeLinks([...links, extra]), newEmbeds: Array.from(embeds), zeroWidth }
}

async function validateDocument(doc: CheckedDocument, opts: { signal?: AbortSignal }): Promise<ValidateOk | ToolRefusal> {
  if (doc.format === 'json') {
    if (doc.rewritten) {
      const misplaced = misplacedInvisible(doc.strings, doc.beforeStrings)
      if (misplaced) return invisibleRefusal(misplaced, 'The change')
      const remote = newRemoteSources(doc.images, doc.beforeImages)
      if (remote.length) return refuse('REMOTE_IMAGE', REMOTE_IMAGE_MESSAGE, { url: remote[0], count: remote.length })
    }
    return {
      ok: true,
      newLinks: newExternalLinks(doc.links, doc.beforeLinks),
      newEmbeds: [],
      zeroWidth: Math.max(0, zeroWidthCount(doc.strings) - zeroWidthCount(doc.beforeStrings)),
    }
  }
  const afterTexts = [doc.body, ...stringsOf(doc.frontmatter)]
  const beforeTexts = doc.before ? [doc.before.body, ...stringsOf(doc.before.frontmatter)] : []
  if (doc.rewritten) {
    if (utf8Bytes(doc.body) > EDIT_LIMITS.bodyBytes) return refuse('EDIT_TOO_LARGE', 'A body would be larger than 256 KiB.')
    const misplaced = misplacedInvisible(afterTexts, beforeTexts)
    if (misplaced) return invisibleRefusal(misplaced, 'The change')
    const remoteCover = newRemoteSources(frontmatterImages(doc.frontmatter), frontmatterImages(doc.before?.frontmatter))
    if (remoteCover.length) return refuse('REMOTE_IMAGE', REMOTE_IMAGE_MESSAGE, { url: remoteCover[0], field: 'cover' })
  }
  const frontLinks = newExternalLinks(frontmatterLinks(doc.frontmatter), frontmatterLinks(doc.before?.frontmatter))
  const zeroWidth = Math.max(0, zeroWidthCount(afterTexts) - zeroWidthCount(beforeTexts))
  // An empty body has nothing to compile or list; neither has a body that did not change.
  if (!doc.body.trim() || (doc.before && doc.before.body === doc.body)) return { ok: true, newLinks: frontLinks, newEmbeds: [], zeroWidth }
  const lang = typeof doc.frontmatter.lang === 'string' ? doc.frontmatter.lang : null
  const verdict = await compileForAi({ body: doc.body, before: doc.before?.body ?? null, lang }, { signal: opts.signal })
  if (!verdict.ok) return compileRefusal(verdict)
  if (doc.rewritten) {
    const remote = newRemoteSources(verdict.refs.images, verdict.beforeRefs.images)
    if (remote.length) return refuse('REMOTE_IMAGE', REMOTE_IMAGE_MESSAGE, { url: remote[0], count: remote.length })
  }
  return {
    ok: true,
    newLinks: mergeLinks([newExternalLinks(bodyLinks(verdict.refs.links), bodyLinks(verdict.beforeRefs.links)), frontLinks]),
    newEmbeds: newPlayerEmbeds(verdict.refs.embeds, verdict.beforeRefs.embeds),
    zeroWidth,
  }
}

/** Check one AI write. `signal` abandons a check still waiting for the worker. */
export async function validateAiWrite(subject: AiWriteSubject, opts: { signal?: AbortSignal } = {}): Promise<ValidateOk | ToolRefusal> {
  if (subject.kind === 'documents') return validateDocuments(subject, opts)
  if (subject.kind === 'texts') {
    if (!Object.values(subject.fields).every(isWellFormed)) return refuse('INVALID_INPUT', 'Texts must be well-formed Unicode.')
    // Whole states, before and after: a field the call leaves alone still counts, so copying one into another is seen.
    const before = Object.values(subject.before ?? {})
    const after = Object.values({ ...(subject.before ?? {}), ...subject.fields })
    const misplaced = misplacedInvisible(after, before)
    if (misplaced) return invisibleRefusal(misplaced, 'The change to these texts')
    return { ok: true, newLinks: [], newEmbeds: [], zeroWidth: Math.max(0, zeroWidthCount(after) - zeroWidthCount(before)) }
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
