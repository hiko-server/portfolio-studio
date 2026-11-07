import { safeCaseStudyUrl } from '../caseStudy'
import { safeLinkHref } from '../rehype/safeUrls'
import { EMBED_SRC_RE } from '../rehype/stripMdxExpressions'
import { safeHref } from '../url'

/**
 * The egress lint of an AI write (pure, design §4.5 steps 2 to 4; THREATS
 * on prompt injection and egress). Text a model writes must not make a
 * visitor's browser — or the server — contact a host the owner never chose,
 * and must not hide instructions in characters nobody sees.
 *
 *   - Invisible characters: TAG characters (U+E0000 to U+E007F) and the
 *     bidi embedding, override and isolate controls (U+202A to U+202E,
 *     U+2066 to U+2069) are refused, except the owner's own exactly where
 *     they stand: a line holding one must come out of the write unchanged
 *     (it may move as a whole). Zero-width characters (U+200B, U+200C,
 *     U+200D, U+2060, U+FEFF) outside the joiner contexts real scripts and
 *     emoji need are counted for the owner, not refused.
 *   - Images: a NEW image or media source that is not a path of this site
 *     (`/uploads/...`, `/images/...`) is refused — a remote image is a
 *     request every visitor makes to its host. Addresses already in the
 *     stored text may stay.
 *   - Links: kept (nothing is fetched until someone clicks), but every new
 *     external one is listed for the owner, flagged when it carries a query,
 *     a fragment, a random-looking path segment, plain http, credentials, an
 *     IP address or another scheme. New player embeds are listed too.
 *
 * Addresses are judged the way the site PRINTS them, not as written: the
 * renderers turn a bare domain (`collector.example/c?d=1`) into an https
 * link (lib/url safeHref), and a target they refuse is no link at all.
 * Each written address therefore goes through the renderers' own rules
 * first (`LINK_RULES`), and what they print is read with the WHATWG URL
 * parser against a placeholder origin, as a browser reads it, so `//host`,
 * `/\host`, `\\host` and control characters inside a scheme are all seen
 * for what they are. Image sources are read both as written and as the
 * Markdown twin prints them (lib/markdownTwin: safeHref).
 */

/** TAG block, bidi embeddings and overrides, bidi isolates. */
const REFUSED_INVISIBLE_RE = /[\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/gu
const HAS_REFUSED_INVISIBLE_RE = /[\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/u

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
 * Line terminators. A bidi control acts up to the end of its paragraph
 * (UAX #9: these are paragraph separators), and a line is what an edit
 * replaces, so a line is the unit an owner's character is kept with.
 */
const LINE_SPLIT_RE = /\r\n|[\n\r\u0085\u2028\u2029]/

/** The lines of `texts` that hold a refused invisible character. */
function invisibleLines(texts: readonly string[]): string[] {
  const out: string[] = []
  for (const t of texts) if (HAS_REFUSED_INVISIBLE_RE.test(t)) for (const line of t.split(LINE_SPLIT_RE)) if (HAS_REFUSED_INVISIBLE_RE.test(line)) out.push(line)
  return out
}

/** A refused invisible character a write would put where it was not: added, or the owner's own carried into changed text. */
export type InvisibleProblem = { char: string; moved: boolean }

/**
 * The first refused invisible character the write misplaces, or null:
 *
 *   - one it adds (a code point that occurs more often after than before);
 *   - one of the owner's own on a line the write changed or created — moved
 *     into new text (a link label, say) or with the text it governs
 *     rewritten. Each line holding such a character must match a line of
 *     the stored text exactly, one for one.
 *
 * So the owner's bidi isolates around an Arabic or Hebrew quote never block
 * an edit elsewhere, and a write can neither add such a character nor carry
 * one into text of its own.
 */
export function misplacedInvisible(after: readonly string[], before: readonly string[]): InvisibleProblem | null {
  const had = invisibleCounts(before)
  for (const [cp, n] of invisibleCounts(after)) if (n > (had.get(cp) ?? 0)) return { char: hex(cp), moved: false }
  const kept = new Map<string, number>()
  for (const line of invisibleLines(before)) kept.set(line, (kept.get(line) ?? 0) + 1)
  for (const line of invisibleLines(after)) {
    const left = kept.get(line) ?? 0
    if (left > 0) {
      kept.set(line, left - 1)
      continue
    }
    const first = line.match(HAS_REFUSED_INVISIBLE_RE)?.[0] ?? ''
    return { char: hex(first.codePointAt(0) as number), moved: true }
  }
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

/**
 * The off-site address an image or media source makes someone load, or
 * null when it is a path of this site. Read twice: as written, the way a
 * browser reads it on the page (a source the page would drop — `data:`,
 * `//host` spelled oddly — is refused, never relied on), and as the
 * Markdown twin and /llms-full.txt print it, where a bare domain
 * (`collector.example/x.png`) becomes an https image.
 */
export function remoteSource(raw: string): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  for (const candidate of [text, safeHref(text)]) {
    if (!candidate) continue
    const read = readAddress(candidate)
    if (read.kind !== 'site') return read.url
  }
  return null
}

/** An image or media source that is not a path of this site (see remoteSource). */
export function isRemoteSource(raw: string): boolean {
  return remoteSource(raw) !== null
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

/** A renderer's rule for a link target: the href it prints, '' when it prints the text without a link. */
export type LinkRule = (raw: unknown) => string

/**
 * The rules each kind of link target is printed by — the renderers' own
 * functions, so the lint lists exactly what reaches a page:
 *
 *   body       Markdown links in a body (inline, by reference, autolinks):
 *              the page (lib/rehype/safeUrls safeLinkHref) and the Markdown
 *              twin and /llms-full.txt (lib/markdownTwin: safeHref);
 *   href       a case study's `link` and `repo` (pages/work/[slug], the
 *              project archive, the twin) — and the home and CV fields of
 *              stage M3: safeHref;
 *   caseStudy  a case study's `links[].url` and `outcomes[].sourceUrl`
 *              (lib/caseStudy cleanLinks and cleanOutcomes): safeCaseStudyUrl.
 */
export const LINK_RULES = {
  body: [safeLinkHref, safeHref],
  href: [safeHref],
  caseStudy: [safeCaseStudyUrl],
} as const satisfies Record<string, readonly LinkRule[]>

/** Every href `raw` is printed as under `rules`, without repeats: [] when it is printed as plain text. */
export function printedLinks(raw: string, rules: readonly LinkRule[]): string[] {
  const out: string[] = []
  for (const rule of rules) {
    const href = rule(raw)
    if (href && !out.includes(href)) out.push(href)
  }
  return out
}

/** Body link targets as written (the worker's parse), as the page and the Markdown twin print them. */
export function bodyLinks(raws: readonly string[]): string[] {
  return raws.flatMap((raw) => printedLinks(raw, LINK_RULES.body))
}

const fmString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** The image an item's frontmatter makes its pages load: the cover, as written. */
export function frontmatterImages(fm: Record<string, unknown> | null | undefined): string[] {
  const cover = fmString(fm?.cover)
  return cover ? [cover] : []
}

/** The links an item's frontmatter prints (a case study's link, repo, extra links and metric sources), as printed. */
export function frontmatterLinks(fm: Record<string, unknown> | null | undefined): string[] {
  if (!fm) return []
  const out: string[] = []
  for (const k of ['link', 'repo']) {
    const raw = fmString(fm[k])
    if (raw) out.push(...printedLinks(raw, LINK_RULES.href))
  }
  const field = (list: unknown, key: string) =>
    (Array.isArray(list) ? list : []).map((o) => (o && typeof o === 'object' ? fmString((o as Record<string, unknown>)[key]) : null)).filter((v): v is string => v !== null)
  for (const raw of [...field(fm.links, 'url'), ...field(fm.outcomes, 'sourceUrl')]) out.push(...printedLinks(raw, LINK_RULES.caseStudy))
  return out
}

/** Sources of `after` that are remote and not already in `before`, as loaded, in order, without repeats. */
export function newRemoteSources(after: readonly string[], before: readonly string[]): string[] {
  const had = new Set(before.map(remoteSource).filter((u): u is string => u !== null))
  const out: string[] = []
  for (const s of after) {
    const url = remoteSource(s)
    if (url !== null && !had.has(url) && !out.includes(url)) out.push(url)
  }
  return out
}

/**
 * External (or other-scheme) links of `after` not already in `before`,
 * with their flags. Both lists hold PRINTED hrefs (bodyLinks,
 * frontmatterLinks, printedLinks): a written target is judged by what the
 * page shows.
 */
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
