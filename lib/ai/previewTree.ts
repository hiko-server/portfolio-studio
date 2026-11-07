/**
 * The tree a change's Preview tab renders (SERVER-ONLY, design §8.2): the
 * site's own compile of the proposed body (in the AI compile worker), made
 * inert before it reaches the owner's browser, so rendering it loads
 * nothing and nothing in it can be followed:
 *
 *   - an image whose every address is a path on this site stays (it is
 *     already an upload of the site); any other image becomes a labelled
 *     placeholder with its address as text;
 *   - players, frames, media elements and anything else that loads or acts
 *     (iframe, the video facades, video, audio, source, picture, object,
 *     embed, script, style, link, meta, base, form controls, svg) become a
 *     placeholder;
 *   - every link becomes text that looks like a link, its address in a
 *     title: a same-site click would carry the Strict cookie, and several
 *     /api/admin GETs act when opened (§8.3);
 *   - event handlers, address-bearing attributes and styles that load
 *     (url(), @import, expression()) are dropped from every element.
 *
 * Pure, so tests/ai-change-ui can feed it hostile trees.
 */

type Props = Record<string, unknown>
export type HastText = { type: 'text'; value: string }
export type HastElement = { type: 'element'; tagName: string; properties?: Props; children: HastChild[] }
export type HastChild = HastElement | HastText | { type: string; value?: string; children?: HastChild[] }
export type HastRootLike = { type: 'root'; children: HastChild[] }

export type PreviewReplacements = { images: number; embeds: number; links: number }

/** Elements that load something or act: never rendered in a preview. */
const BLOCKED = new Set([
  'iframe',
  'frame',
  'frameset',
  'embed',
  'object',
  'applet',
  'portal',
  'youtube-embed',
  'vimeo-embed',
  'video',
  'audio',
  'source',
  'track',
  'picture',
  'script',
  'noscript',
  'template',
  'style',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'svg',
  'math',
  'image',
  'canvas',
  'dialog',
])

/** Attributes that name an address (hast property names and their HTML spellings). */
const URL_PROPS = new Set([
  'src',
  'srcSet',
  'srcset',
  'poster',
  'href',
  'xLinkHref',
  'xlinkHref',
  'data',
  'action',
  'formAction',
  'cite',
  'background',
  'ping',
  'manifest',
  'longDesc',
  'useMap',
  'codeBase',
  'archive',
  'profile',
  'icon',
  'itemId',
  'lowsrc',
  'dynsrc',
])

const LOADING_STYLE = /url\s*\(|@import|expression\s*\(|image-set\s*\(/i

/** A path on this site: one leading slash, no scheme, no backslash, no control character. */
export function isSitePath(value: unknown): value is string {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) && !/[\\\u0000-\u001f]/.test(value)
}

const asText = (v: unknown): string => (Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

/** The candidate addresses of a srcset value. */
function srcsetUrls(v: unknown): string[] {
  return asText(v)
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)
}

function placeholder(kind: 'image' | 'player', address: string): HastElement {
  const label = kind === 'image' ? '[image not loaded]' : '[player not loaded]'
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['ai-preview-blocked'], dataBlocked: kind },
    children: [{ type: 'text', value: address ? `${label} ${address}` : label }],
  }
}

/** The element's properties without handlers, addresses or loading styles. */
function cleanProps(props: Props | undefined, keep: readonly string[] = []): Props {
  const out: Props = {}
  for (const [name, value] of Object.entries(props ?? {})) {
    if (/^on/i.test(name)) continue
    if (URL_PROPS.has(name) && !keep.includes(name)) continue
    if (name === 'style' && LOADING_STYLE.test(asText(value))) continue
    out[name] = value
  }
  return out
}

/** The address an element would load, for its placeholder's text. */
function addressOf(el: HastElement): string {
  const p = el.properties ?? {}
  for (const key of ['src', 'href', 'data', 'poster', 'srcSet', 'srcset']) {
    const v = asText(p[key])
    if (v) return v
  }
  for (const [k, v] of Object.entries(p)) if (/^data(Id|Url|Src|Video)/i.test(k) && asText(v)) return asText(v)
  return ''
}

/**
 * The inert copy of a compiled tree, with how many images, players and
 * links were replaced. The input is not changed.
 */
export function inertPreviewTree(tree: unknown): { tree: HastRootLike; replaced: PreviewReplacements } {
  const replaced: PreviewReplacements = { images: 0, embeds: 0, links: 0 }

  const visit = (node: HastChild): HastChild | null => {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'text') return { type: 'text', value: String((node as HastText).value ?? '') }
    // Comments, doctypes, raw HTML and MDX leftovers carry nothing a reader needs.
    if (node.type !== 'element') return null
    const el = node as HastElement
    const tag = String(el.tagName || '').toLowerCase()
    const children = () => (Array.isArray(el.children) ? el.children.map(visit).filter((c): c is HastChild => c !== null) : [])
    if (BLOCKED.has(tag)) {
      replaced.embeds++
      return placeholder('player', addressOf(el))
    }
    if (tag === 'img') {
      const p = el.properties ?? {}
      const sources = [p.src, ...srcsetUrls(p.srcSet ?? p.srcset)].filter((v) => v !== undefined && v !== null && v !== '')
      if (sources.length && sources.every(isSitePath)) {
        const props = cleanProps(p, ['src', 'srcSet', 'srcset'])
        return { type: 'element', tagName: 'img', properties: props, children: [] }
      }
      replaced.images++
      return placeholder('image', asText(p.src) || srcsetUrls(p.srcSet ?? p.srcset)[0] || '')
    }
    if (tag === 'a') {
      replaced.links++
      const href = asText(el.properties?.href)
      const props = cleanProps(el.properties)
      const className = ['ai-preview-link', ...(Array.isArray(props.className) ? (props.className as string[]) : [])]
      return { type: 'element', tagName: 'span', properties: { ...props, className, ...(href ? { title: href } : {}) }, children: children() }
    }
    return { type: 'element', tagName: el.tagName, properties: cleanProps(el.properties), children: children() }
  }

  const root = tree && typeof tree === 'object' && Array.isArray((tree as HastRootLike).children) ? (tree as HastRootLike) : { type: 'root' as const, children: [] }
  return { tree: { type: 'root', children: root.children.map(visit).filter((c): c is HastChild => c !== null) }, replaced }
}

/** The body of a preview document's text (lib's documentText: `key: value` lines, a `---` line, then the body). */
export function bodyOfDocumentText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const at = lines.indexOf('---')
  return at < 0 ? text : lines.slice(at + 1).join('\n')
}
