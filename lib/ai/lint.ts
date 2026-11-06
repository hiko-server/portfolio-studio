import { EMBED_SRC_RE } from '../rehype/stripMdxExpressions'
import type { MdxRefs } from './compileJob'

/**
 * The egress lint of an AI write (pure, design §4.5 steps 2 to 4; THREATS
 * on prompt injection and egress). Text a model writes must not make a
 * visitor's browser — or the server — contact a host the owner never chose,
 * and must not hide instructions in characters nobody sees.
 *
 *   - Invisible characters: TAG characters (U+E0000 to U+E007F) and the
 *     bidi embedding, override and isolate controls (U+202A to U+202E,
 *     U+2066 to U+2069) are refused when a write adds any. Zero-width
 *     characters (U+200B, U+200C, U+200D, U+2060, U+FEFF) outside the
 *     joiner contexts real scripts and emoji need are counted for the
 *     owner, not refused.
 *   - Images: a NEW image or media source that is not a path of this site
 *     (`/uploads/...`, `/images/...`) is refused — a remote image is a
 *     request every visitor makes to its host. Addresses already in the
 *     stored text may stay.
 *   - Links: kept (nothing is fetched until someone clicks), but every new
 *     external one is listed for the owner, flagged when it carries a query,
 *     a fragment, a random-looking path segment, plain http, credentials, an
 *     IP address or another scheme. New player embeds are listed too.
 *
 * Addresses are read with the WHATWG URL parser against a placeholder
 * origin, as a browser reads them, so `//host`, `/\host`, `\\host` and
 * control characters inside a scheme are all seen for what they are.
 */

/** TAG block, bidi embeddings and overrides, bidi isolates. */
const REFUSED_INVISIBLE_RE = /[‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/gu

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`

function invisibleCounts(texts: readonly string[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const t of texts) {
    for (const m of t.matchAll(REFUSED_INVISIBLE_RE)) {
      const cp = m[0].codePointAt(0) as number
      out.set(cp, (out.get(cp) ?? 0) + 1)
    }
  }
  return out
}

/**
 * The first refused invisible character the write adds (one that occurs
 * more often after than before), or null. Characters the owner already had
 * in the stored text are left alone.
 */
export function addedInvisible(after: readonly string[], before: readonly string[]): { char: string } | null {
  const had = invisibleCounts(before)
  for (const [cp, n] of invisibleCounts(after)) if (n > (had.get(cp) ?? 0)) return { char: hex(cp) }
  return null
}

const ZERO_WIDTH_RE = /[​‌‍⁠﻿]/gu
/** Scripts whose letters join, where ZWJ and ZWNJ shape text (Arabic, Syriac, the Indic scripts, ...), and combining marks. */
const JOINING_RE =
  /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\p{M}]/u
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️]/u

function legitimateJoiner(text: string, at: number, ch: string): boolean {
  if (ch !== '‌' && ch !== '‍') return false
  const prev = Array.from(text.slice(Math.max(0, at - 2), at)).pop() ?? ''
  const next = Array.from(text.slice(at + 1, at + 3))[0] ?? ''
  if (ch === '‍' && EMOJI_RE.test(prev) && /\p{Extended_Pictographic}/u.test(next)) return true
  return JOINING_RE.test(prev) && JOINING_RE.test(next)
}

/** Zero-width characters outside joiner contexts real text needs. */
export function zeroWidthCount(texts: readonly string[]): number {
  let n = 0
  for (const t of texts) for (const m of t.matchAll(ZERO_WIDTH_RE)) if (!legitimateJoiner(t, m.index as number, m[0])) n++
  return n
}

// ── Addresses ────────────────────────────────────────────────────────────

const PLACEHOLDER = 'https://site.invalid'
const PLACEHOLDER_PAGE = `${PLACEHOLDER}/a/b`

/** How a browser reads `raw` on a page of this site: this site, another site, or another scheme. */
export function readAddress(raw: string): { kind: 'site' | 'external' | 'scheme' | 'malformed'; url: string } {
  const text = String(raw ?? '').trim()
  let u: URL
  try {
    u = new URL(text, PLACEHOLDER_PAGE)
  } catch {
    return { kind: 'malformed', url: text.slice(0, 2048) }
  }
  if (u.origin === PLACEHOLDER) return { kind: 'site', url: `${u.pathname}${u.search}${u.hash}` }
  if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'external', url: u.href }
  return { kind: 'scheme', url: u.href.slice(0, 2048) }
}

/** An image or media source that is not a path of this site. */
export function isRemoteSource(raw: string): boolean {
  const text = String(raw ?? '').trim()
  if (!text) return false
  return readAddress(text).kind !== 'site'
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** A path segment that reads like an identifier or token rather than words. */
function randomLooking(segment: string): boolean {
  let s: string
  try {
    s = decodeURIComponent(segment)
  } catch {
    s = segment
  }
  if (s.length < 16) return false
  if (s.length >= 48 && /^[A-Za-z0-9_\-=+/.~]+$/.test(s)) return true
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(s)).length
  if (classes < 2) return false
  let switches = 0
  const kind = (c: string) => (/[a-z]/.test(c) ? 'l' : /[A-Z]/.test(c) ? 'u' : /[0-9]/.test(c) ? 'd' : 'o')
  for (let i = 1; i < s.length; i++) if (kind(s[i]) !== kind(s[i - 1])) switches++
  return switches >= 6
}

/** Why the owner should look twice at an external link. */
export function linkFlags(raw: string): string[] {
  const read = readAddress(raw)
  if (read.kind === 'malformed') return ['malformed']
  if (read.kind === 'scheme') return ['scheme']
  if (read.kind !== 'external') return []
  const u = new URL(read.url)
  const flags: string[] = []
  if (u.protocol === 'http:') flags.push('not-https')
  if (u.username || u.password) flags.push('credentials')
  if (IPV4_RE.test(u.hostname) || u.hostname.startsWith('[')) flags.push('ip-address')
  if (u.search) flags.push('query')
  if (u.hash) flags.push('fragment')
  if (u.pathname.split('/').some(randomLooking)) flags.push('random-path')
  return flags
}

export type NewLink = { url: string; flags: string[] }

/** What an item's frontmatter makes a page load (cover) or link to (case-study links and sources). */
export function frontmatterRefs(fm: Record<string, unknown> | null | undefined): MdxRefs {
  const out: MdxRefs = { images: [], links: [], embeds: [] }
  if (!fm) return out
  if (typeof fm.cover === 'string' && fm.cover.trim()) out.images.push(fm.cover)
  for (const k of ['link', 'repo']) if (typeof fm[k] === 'string' && (fm[k] as string).trim()) out.links.push(fm[k] as string)
  for (const l of Array.isArray(fm.links) ? fm.links : []) if (l && typeof l === 'object' && typeof (l as { url?: unknown }).url === 'string') out.links.push((l as { url: string }).url)
  for (const o of Array.isArray(fm.outcomes) ? fm.outcomes : []) {
    if (o && typeof o === 'object' && typeof (o as { sourceUrl?: unknown }).sourceUrl === 'string') out.links.push((o as { sourceUrl: string }).sourceUrl)
  }
  return out
}

/** Sources of `after` that are remote and not already in `before`, in order, without repeats. */
export function newRemoteSources(after: readonly string[], before: readonly string[]): string[] {
  const had = new Set(before.filter(isRemoteSource).map((s) => readAddress(s).url))
  const out: string[] = []
  for (const s of after) {
    if (!isRemoteSource(s)) continue
    const url = readAddress(s).url
    if (!had.has(url) && !out.includes(url)) out.push(url)
  }
  return out
}

/** External (or other-scheme) links of `after` not already in `before`, with their flags. */
export function newExternalLinks(after: readonly string[], before: readonly string[]): NewLink[] {
  const outside = (s: string) => readAddress(s).kind !== 'site'
  const had = new Set(before.filter(outside).map((s) => readAddress(s).url))
  const out: NewLink[] = []
  const seen = new Set<string>()
  for (const s of after) {
    if (!outside(s)) continue
    const url = readAddress(s).url
    if (had.has(url) || seen.has(url)) continue
    seen.add(url)
    out.push({ url, flags: linkFlags(s) })
  }
  return out
}

/** Player embeds of `after` the renderer will show (EMBED_SRC_RE) that `before` did not have. */
export function newPlayerEmbeds(after: readonly string[], before: readonly string[]): string[] {
  const had = new Set(before.map((s) => s.trim()))
  const out: string[] = []
  for (const raw of after) {
    const s = raw.trim()
    if (EMBED_SRC_RE.test(s) && !had.has(s) && !out.includes(s)) out.push(s)
  }
  return out
}
