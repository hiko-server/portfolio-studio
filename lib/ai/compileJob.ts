import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMdx from 'remark-mdx'
import remarkGfm from 'remark-gfm'
import { compileMdx, MdxCompileError } from '../mdx'

/**
 * The check an AI write's MDX body passes (SERVER-ONLY, design §4.5). It
 * runs inside the compile worker (lib/ai/compileWorker, started by
 * lib/ai/compile), never on the main thread: parsing is synchronous, and a
 * hostile body ("[a](" repeated, thousands of table rows) holds a thread
 * for seconds or exhausts its heap.
 *
 * One job reads two bodies with the site's real parser (remark-parse,
 * remark-mdx, remark-gfm), so every Markdown and MDX form is seen the way
 * the renderer sees it, reference-style links and images included:
 *
 *   - `before`, the stored body (or the editor's): only its references, so
 *     a remote image that is already there may stay (§4.5 step 3);
 *   - `body`, the new body: its references, then the full public compile
 *     (lib/mdx compileMdx) with every resolver replaced by one that answers
 *     nothing — no image sizes, srcsets, placeholders or video posters, so
 *     the check makes no network request, reads no file and opens no
 *     database. Human saves keep the full compile.
 *
 * Nothing here throws: every outcome is an answer.
 */

/** Every address a body makes the page load or link to, in document order. */
export type MdxRefs = {
  /** Image and media sources: Markdown images (inline and by reference), and any JSX `src`, `srcset`/`srcSet` or `poster` outside an iframe. */
  images: string[]
  /** Link targets: Markdown links (inline, by reference, GitHub autolinks). */
  links: string[]
  /** Player embeds: an `<iframe src>` and a `<YouTube id>` (as its player address). */
  embeds: string[]
}

export type CompileJob = { id: number; body: string; before: string | null; lang: string | null }

export type CompileAnswer =
  | { id: number; ok: true; refs: MdxRefs; beforeRefs: MdxRefs }
  | { id: number; ok: false; code: 'MDX_INVALID'; line: number | null; column: number | null; reason: string }
  | { id: number; ok: false; code: 'MDX_TOO_COMPLEX' }

type Node = {
  type: string
  url?: string
  identifier?: string
  name?: string | null
  attributes?: Array<{ type: string; name?: string; value?: unknown }>
  children?: Node[]
}

const parser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm)

const empty = (): MdxRefs => ({ images: [], links: [], embeds: [] })

/** The URL candidates of a `srcset` value: the first token of each comma-separated entry. */
function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)
}

const MEDIA_ATTRS = new Set(['src', 'srcset', 'srcSet', 'poster'])

/** The references of an mdast tree (definitions resolved for reference-style links and images). */
export function refsOf(tree: Node): MdxRefs {
  const definitions = new Map<string, string>()
  const visitDefs = (node: Node) => {
    if (node.type === 'definition' && node.identifier && typeof node.url === 'string' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
    for (const child of node.children ?? []) visitDefs(child)
  }
  visitDefs(tree)

  const out = empty()
  const visit = (node: Node) => {
    switch (node.type) {
      case 'image':
        if (typeof node.url === 'string') out.images.push(node.url)
        break
      case 'imageReference': {
        const url = node.identifier ? definitions.get(node.identifier) : undefined
        if (url !== undefined) out.images.push(url)
        break
      }
      case 'link':
        if (typeof node.url === 'string') out.links.push(node.url)
        break
      case 'linkReference': {
        const url = node.identifier ? definitions.get(node.identifier) : undefined
        if (url !== undefined) out.links.push(url)
        break
      }
      case 'mdxJsxFlowElement':
      case 'mdxJsxTextElement': {
        const iframe = node.name === 'iframe'
        for (const attr of node.attributes ?? []) {
          if (attr.type !== 'mdxJsxAttribute' || !attr.name) continue
          // An expression value (`src={…}`) is removed before rendering; its text is still checked, so nothing slips by.
          const raw = typeof attr.value === 'string' ? attr.value : attr.value && typeof attr.value === 'object' ? String((attr.value as { value?: unknown }).value ?? '') : null
          if (raw === null) continue
          if (node.name === 'YouTube' && attr.name === 'id') out.embeds.push(`https://www.youtube-nocookie.com/embed/${raw.trim()}`)
          else if (iframe && attr.name === 'src') out.embeds.push(raw)
          else if (MEDIA_ATTRS.has(attr.name)) {
            if (attr.name === 'src' || attr.name === 'poster') out.images.push(raw)
            else out.images.push(...srcsetUrls(raw))
          }
        }
        break
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return out
}

/** Answers that mean "this body is too expensive to check", not "this body is wrong". */
const TOO_COMPLEX_RE = /Maximum call stack size exceeded|Invalid string length|Array buffer allocation failed/i

function tooComplex(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return err instanceof RangeError || TOO_COMPLEX_RE.test(text) || (err instanceof MdxCompileError && TOO_COMPLEX_RE.test(err.reason))
}

const POSITION_RE = /\((\d+):(\d+)(?:-\d+:\d+)?\)/

function positionOf(err: unknown): { line: number | null; column: number | null } {
  const e = (err && typeof err === 'object' ? err : {}) as { line?: unknown; column?: unknown; place?: { line?: unknown; column?: unknown; start?: { line?: unknown; column?: unknown } }; reason?: unknown; message?: unknown }
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)
  const line = num(e.line) ?? num(e.place?.start?.line) ?? num(e.place?.line)
  if (line !== null) return { line, column: num(e.column) ?? num(e.place?.start?.column) ?? num(e.place?.column) }
  const m = POSITION_RE.exec(String(e.reason ?? e.message ?? ''))
  return m ? { line: Number(m[1]), column: Number(m[2]) } : { line: null, column: null }
}

function invalid(id: number, err: unknown): CompileAnswer {
  if (tooComplex(err)) return { id, ok: false, code: 'MDX_TOO_COMPLEX' }
  const reason = (err instanceof MdxCompileError ? err.reason : err instanceof Error ? (err as Error & { reason?: string }).reason || err.message : String(err)).slice(0, 500)
  return { id, ok: false, code: 'MDX_INVALID', ...positionOf(err), reason: reason || 'The MDX body could not be compiled' }
}

/** Resolvers that answer nothing: no size, srcset, placeholder or poster is looked up anywhere. */
const NOTHING = {
  resolveSize: () => null,
  srcSetFor: () => null,
  avifSrcSetFor: () => null,
  placeholderFor: () => null,
  posterFor: () => null,
} as const

/** Run one job. Never throws. */
export async function runCompileJob(job: CompileJob): Promise<CompileAnswer> {
  const id = job.id
  let beforeRefs = empty()
  if (typeof job.before === 'string' && job.before) {
    try {
      beforeRefs = refsOf(parser.parse(job.before) as Node)
    } catch (err) {
      // A stored body the parser refuses has no references it can vouch for: everything in the new body counts as new.
      if (tooComplex(err)) return { id, ok: false, code: 'MDX_TOO_COMPLEX' }
    }
  }
  let refs: MdxRefs
  try {
    refs = refsOf(parser.parse(String(job.body ?? '')) as Node)
  } catch (err) {
    return invalid(id, err)
  }
  try {
    await compileMdx(String(job.body ?? ''), { ...(job.lang ? { lang: job.lang } : {}), ...NOTHING })
  } catch (err) {
    return invalid(id, err)
  }
  return { id, ok: true, refs, beforeRefs }
}
