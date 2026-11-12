import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { imageJobs } from '../imageJobs'
import { assertImageWithinLimits, ImageRejectedError, sniffImageType, uploadsDir } from '../imageVariants'
import { isValidUploadName } from '../security/uploadName'
import { getAiDb } from './db'
import { isMediaRef as isRef, MEDIA_ID_RE, mediaRef, type MediaRef } from './providers/mediaRef'
import type { MediaPart, NativeTurn, Wire } from './providers/types'

/**
 * Files the owner gives the assistant (SERVER-ONLY): images, PDFs, text
 * files and audio clips, in ai.db `ai_media` (scripts/db/ai/003-media).
 *
 * The flow:
 *   1. The browser uploads one file (POST /api/admin/ai/uploads, JSON
 *      `{ filename, dataUrl }` like every other upload here). It is checked
 *      by what its bytes ARE, never by the name or type the browser claims:
 *        image  JPEG, PNG, WebP or GIF by magic number, under the
 *               decompression-bomb limit; re-encoded upright, at most
 *               2048 px on the long edge, with every bit of metadata (EXIF
 *               GPS, camera serials, XMP) dropped — what reaches a model is
 *               pixels only. JPEG, or PNG when it has transparency (WebP when
 *               that PNG would be too large for a provider's per-image limit).
 *        text   a known text or source-code extension (or a text/* type)
 *               whose bytes are valid UTF-8 with no NUL byte, at most 512 KB.
 *               Checked before the PDF and audio sniffing, so a text file
 *               that happens to contain "%PDF-" or start with "ID3" stays text.
 *        pdf    `%PDF-` near the start and an end-of-file marker, at most
 *               7 MB; the page count is an estimate (shown, never trusted).
 *        audio  WAV (RIFF/WAVE) or MP3 (a valid ID3v2 header or frame
 *               header), at most 7 MB.
 *      Every kind stays under 7 MB so its base64 data URL fits the proxy's
 *      10 MB request-body limit (Next clones a body only that far).
 *      It is stored pending: bound to the browser session that sent it and
 *      to no conversation. Pending files are deleted after a day.
 *   2. The message that carries it claims it (lib/ai/runs): from then on it
 *      belongs to that conversation and is deleted with it.
 *   3. The stored native turn never holds the bytes: the adapters put a
 *      placeholder `{ "$aiMedia": id, "enc": "base64" | "data-url" }` where
 *      a provider wants the data, and the loop fills them in just before each
 *      model call (`hydrateHistory`) — only in turns the SERVER wrote (user
 *      turns), never in one a model wrote. The history stays small and
 *      byte-identical from call to call, which prompt caching needs.
 *
 * What a model is sent, per wire (lib/ai/providers/*): Claude takes images
 * and PDFs as content blocks; the Responses wire input_image / input_file;
 * the Chat wire image_url, file and input_audio parts. Text files go inline
 * in the message as quoted data (lib/ai/systemPrompt), on every wire.
 */

export type MediaKind = 'image' | 'pdf' | 'text' | 'audio'
export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'pdf', 'text', 'audio']

export { MEDIA_ID_RE, mediaRef, type MediaRef }
/** Files one message may carry. */
export const MEDIA_PER_MESSAGE = 10
/**
 * Model-visible files (images, PDFs, audio) one conversation may hold: its
 * history carries them on every call, base64 (a third larger), and Claude
 * takes at most 32 MB per request — 18 MiB leaves room for the encoding and
 * the rest of the history.
 */
export const CONVERSATION_MEDIA_BYTES = 18 * 1024 * 1024
/** Pending files one session may hold at once (uploaded, not sent yet). */
export const PENDING_PER_SESSION = 40
export const PENDING_BYTES_PER_SESSION = 120 * 1024 * 1024
/** How long a file nobody sent is kept. */
export const PENDING_TTL_MS = 24 * 60 * 60_000

export const LIMITS: Record<MediaKind, number> = {
  image: 7 * 1024 * 1024,
  pdf: 7 * 1024 * 1024,
  text: 512 * 1024,
  audio: 7 * 1024 * 1024,
}
/** The most one stored image may weigh: providers cap a single image (Claude at 5 MB), so a larger PNG becomes WebP. */
export const IMAGE_MAX_BYTES = Math.floor(3.75 * 1024 * 1024)
/** The long edge an image is scaled down to (within every vision model's limit, and its cost). */
export const IMAGE_EDGE = 2048
/** All text files of one message together (they are quoted into it). */
export const TEXT_PER_MESSAGE_BYTES = 768 * 1024

const TEXT_EXTENSIONS = new Set(
  (
    'txt text md markdown mdx rst adoc csv tsv json jsonl ndjson yaml yml toml ini cfg conf env log xml svg html htm css scss less ' +
    'js mjs cjs jsx ts tsx mts cts vue svelte astro py rb go rs java kt kts swift c h cc cpp hpp cs php pl lua r sql sh bash zsh fish ' +
    'ps1 bat dockerfile makefile gradle properties tex bib srt vtt diff patch'
  ).split(' '),
)

/** What a browser or a tool sees of a file (never its bytes). */
export type MediaView = {
  id: string
  kind: MediaKind
  mime: string
  name: string
  size: number
  width: number | null
  height: number | null
  pages: number | null
  durationMs: number | null
  chars: number | null
}

type MediaRow = {
  id: string
  conversation_id: string | null
  session_id: string | null
  kind: MediaKind
  mime: string
  name: string
  size: number
  sha256: string
  width: number | null
  height: number | null
  pages: number | null
  duration_ms: number | null
  chars: number | null
  created_at: number
}

const VIEW_COLUMNS = 'id, conversation_id, session_id, kind, mime, name, size, sha256, width, height, pages, duration_ms, chars, created_at'

function viewOf(r: MediaRow): MediaView {
  return { id: r.id, kind: r.kind, mime: r.mime, name: r.name, size: r.size, width: r.width, height: r.height, pages: r.pages, durationMs: r.duration_ms, chars: r.chars }
}

export class MediaRejected extends Error {
  readonly status: 400 | 413 | 415 | 429
  readonly code: string
  constructor(status: 400 | 413 | 415 | 429, code: string, message: string) {
    super(message)
    this.name = 'MediaRejected'
    this.status = status
    this.code = code
  }
}

// ── Names ────────────────────────────────────────────────────────────────

/** A file name as shown and sent to a model: the last path segment, plain characters, at most 120. */
export function cleanName(raw: unknown, fallback = 'file'): string {
  const base = typeof raw === 'string' ? raw.split(/[\\/]/).pop() ?? '' : ''
  // eslint-disable-next-line no-control-regex
  const flat = base.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>"`]/g, '').replace(/\s+/g, ' ').trim()
  const name = flat.length > 120 ? `${flat.slice(0, 80)}…${flat.slice(-39)}` : flat
  return name || fallback
}

const extOf = (name: string) => {
  const lower = name.toLowerCase()
  if (lower === 'dockerfile' || lower === 'makefile') return lower
  const m = /\.([a-z0-9]{1,12})$/.exec(lower)
  return m ? m[1] : ''
}

const withExt = (name: string, ext: string) => (extOf(name) === ext ? name : `${name.replace(/\.[A-Za-z0-9]{1,12}$/, '')}.${ext}`)

// ── Sniffing ─────────────────────────────────────────────────────────────

export function isPdf(buf: Buffer): boolean {
  // The header may follow a little junk (the spec allows it within the first 1024 bytes), then a version digit;
  // a real PDF also ends with %%EOF (or at least carries a startxref) — a text file quoting "%PDF-" does not.
  const head = buf.subarray(0, 1024).toString('latin1')
  if (!/%PDF-\d/.test(head)) return false
  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1')
  return tail.includes('%%EOF') || tail.includes('startxref')
}

export function isWav(buf: Buffer): boolean {
  return buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'
}

export function isMp3(buf: Buffer): boolean {
  if (buf.length < 10) return false
  if (buf.toString('ascii', 0, 3) === 'ID3') {
    // ID3v2: major version 2–4, revision < 0xff, and a syncsafe size (no high bit in its four bytes).
    return buf[3] >= 2 && buf[3] <= 4 && buf[4] < 0xff && [6, 7, 8, 9].every((i) => (buf[i] & 0x80) === 0)
  }
  // An MPEG audio frame header: 11 sync bits, layer III, a real bitrate index (not 0 or 15) and sample rate (not 3).
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) === 0x02 && ((buf[2] >> 4) & 0x0f) !== 0 && ((buf[2] >> 4) & 0x0f) !== 0x0f && ((buf[2] >> 2) & 0x03) !== 0x03
}

/** Duration of a PCM WAV from its header, or null. */
export function wavDurationMs(buf: Buffer): number | null {
  if (!isWav(buf)) return null
  let offset = 12
  let byteRate = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 16 <= buf.length) byteRate = buf.readUInt32LE(offset + 16)
    if (id === 'data') return byteRate > 0 ? Math.round((Math.min(size, buf.length - offset - 8) / byteRate) * 1000) : null
    offset += 8 + size + (size % 2)
  }
  return null
}

/** Pages of a PDF, counted from its page objects: an estimate for the owner, never a limit anyone relies on. */
export function pdfPages(buf: Buffer): number | null {
  const text = buf.toString('latin1')
  const m = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)
  return m && m.length ? m.length : null
}

/** UTF-8 text without NUL bytes, or null. */
export function utf8Text(buf: Buffer): string | null {
  if (buf.includes(0)) return null
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return null
  }
}

// ── Uploads ──────────────────────────────────────────────────────────────

export type ParsedMedia = { kind: MediaKind; mime: string; name: string; bytes: Buffer; width: number | null; height: number | null; pages: number | null; durationMs: number | null; chars: number | null }

/** Decode `{ filename, dataUrl }` (base64 data URL). Pure but for the image re-encode. */
export function decodeUploadBody(body: unknown): { filename: string; declared: string; buf: Buffer } {
  const { filename, dataUrl } = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as { filename?: unknown; dataUrl?: unknown }
  if (typeof dataUrl !== 'string' || !dataUrl) throw new MediaRejected(400, 'INVALID', 'Send { filename, dataUrl }.')
  const match = /^data:([^;,]{0,120})(?:;[^;,]{0,80})*;base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new MediaRejected(400, 'INVALID', 'The file is not a base64 data URL.')
  const buf = Buffer.from(match[2], 'base64')
  if (!buf.length) throw new MediaRejected(400, 'EMPTY', 'The file is empty.')
  return { filename: cleanName(filename), declared: match[1].toLowerCase(), buf }
}

/** What an image becomes before any model sees it: upright, metadata-free, at most IMAGE_EDGE. */
export async function normalizeImage(buf: Buffer): Promise<{ bytes: Buffer; mime: 'image/jpeg' | 'image/png' | 'image/webp'; width: number; height: number }> {
  if (!sniffImageType(buf)) throw new MediaRejected(415, 'NOT_AN_IMAGE', 'Images are JPEG, PNG, WebP or GIF.')
  try {
    await assertImageWithinLimits(buf)
  } catch (err) {
    if (err instanceof ImageRejectedError) throw new MediaRejected(err.status, err.code, err.message)
    throw err
  }
  return imageJobs().run(async () => {
    try {
      // The first frame of an animation; orientation applied, then every metadata block dropped (sharp keeps none by default).
      const base = sharp(buf, { limitInputPixels: 80e6, failOn: 'error', animated: false }).rotate().resize({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
      const stats = await base.clone().stats()
      const alpha = !stats.isOpaque
      if (!alpha) {
        const out = await base.flatten({ background: '#ffffff' }).jpeg({ quality: 86, mozjpeg: true }).toBuffer({ resolveWithObject: true })
        return { bytes: out.data, mime: 'image/jpeg' as const, width: out.info.width, height: out.info.height }
      }
      const png = await base.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true })
      if (png.data.length <= IMAGE_MAX_BYTES) return { bytes: png.data, mime: 'image/png' as const, width: png.info.width, height: png.info.height }
      // A transparent photo as PNG can pass a provider's per-image limit: WebP keeps the transparency at a fraction.
      let webp = await base.clone().webp({ quality: 90, alphaQuality: 100 }).toBuffer({ resolveWithObject: true })
      if (webp.data.length > IMAGE_MAX_BYTES) {
        webp = await sharp(buf, { limitInputPixels: 80e6, failOn: 'error' }).rotate().resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true })
      }
      return { bytes: webp.data, mime: 'image/webp' as const, width: webp.info.width, height: webp.info.height }
    } catch (err) {
      if (err instanceof MediaRejected) throw err
      throw new MediaRejected(415, 'UNREADABLE_IMAGE', 'The image could not be read (corrupt or unsupported file).')
    }
  })
}

/** Check one uploaded file by its bytes and make it what a model may see. */
export async function parseMedia(filename: string, declared: string, buf: Buffer): Promise<ParsedMedia> {
  const ext = extOf(filename)
  const none = { width: null, height: null, pages: null, durationMs: null, chars: null }
  if (sniffImageType(buf)) {
    if (buf.length > LIMITS.image) throw new MediaRejected(413, 'TOO_LARGE', 'Images can be at most 7 MB.')
    const img = await normalizeImage(buf)
    return { ...none, kind: 'image', mime: img.mime, name: withExt(filename, img.mime === 'image/png' ? 'png' : img.mime === 'image/webp' ? 'webp' : 'jpg'), bytes: img.bytes, width: img.width, height: img.height }
  }
  // A text or code file is text whatever its bytes happen to contain ("%PDF-", a leading "ID3").
  const textual = TEXT_EXTENSIONS.has(ext) || declared.startsWith('text/') || declared === 'application/json' || declared === 'application/xml'
  const text = textual && buf.length <= LIMITS.text ? utf8Text(buf) : null
  if (text !== null) return { ...none, kind: 'text', mime: 'text/plain; charset=utf-8', name: filename, bytes: Buffer.from(text, 'utf8'), chars: text.length }
  if (isPdf(buf)) {
    if (buf.length > LIMITS.pdf) throw new MediaRejected(413, 'TOO_LARGE', 'PDFs can be at most 7 MB.')
    return { ...none, kind: 'pdf', mime: 'application/pdf', name: withExt(filename, 'pdf'), bytes: buf, pages: pdfPages(buf) }
  }
  if (isWav(buf) || isMp3(buf)) {
    if (buf.length > LIMITS.audio) throw new MediaRejected(413, 'TOO_LARGE', 'Audio clips can be at most 7 MB (about 3½ minutes).')
    const wav = isWav(buf)
    return { ...none, kind: 'audio', mime: wav ? 'audio/wav' : 'audio/mpeg', name: withExt(filename, wav ? 'wav' : 'mp3'), bytes: buf, durationMs: wav ? wavDurationMs(buf) : null }
  }
  if (textual) {
    if (buf.length > LIMITS.text) throw new MediaRejected(413, 'TOO_LARGE', 'Text files can be at most 512 KB.')
    throw new MediaRejected(415, 'NOT_TEXT', 'This file is not UTF-8 text.')
  }
  throw new MediaRejected(415, 'UNSUPPORTED', 'Attach images (JPEG, PNG, WebP, GIF), PDFs, text or code files, or WAV / MP3 audio.')
}

const newMediaId = () => `m_${crypto.randomBytes(16).toString('base64url')}`

/** Delete files nobody sent within PENDING_TTL_MS. Returns how many went. */
export function prunePendingMedia(now = Date.now()): number {
  return getAiDb().prepare('DELETE FROM ai_media WHERE conversation_id IS NULL AND created_at < ?').run(now - PENDING_TTL_MS).changes
}

/** Store a checked file as pending for `sessionId`. */
export function storePendingMedia(m: ParsedMedia, sessionId: string, now = Date.now()): MediaView {
  const db = getAiDb()
  return db.transaction(() => {
    prunePendingMedia(now)
    const held = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM ai_media WHERE conversation_id IS NULL AND session_id = ?').get(sessionId) as { n: number; bytes: number }
    if (held.n >= PENDING_PER_SESSION || held.bytes + m.bytes.length > PENDING_BYTES_PER_SESSION) {
      throw new MediaRejected(429, 'TOO_MANY_PENDING', 'Too many files are waiting to be sent. Send or remove some first.')
    }
    const id = newMediaId()
    const sha256 = crypto.createHash('sha256').update(m.bytes).digest('hex')
    db.prepare(
      `INSERT INTO ai_media (id, conversation_id, session_id, kind, mime, name, bytes, size, sha256, width, height, pages, duration_ms, chars, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, m.kind, m.mime, m.name, m.bytes, m.bytes.length, sha256, m.width, m.height, m.pages, m.durationMs, m.chars, now)
    return { id, kind: m.kind, mime: m.mime, name: m.name, size: m.bytes.length, width: m.width, height: m.height, pages: m.pages, durationMs: m.durationMs, chars: m.chars }
  })()
}

/** Remove a pending file the owner took back out of the message box. */
export function deletePendingMedia(id: string, sessionId: string): boolean {
  if (!MEDIA_ID_RE.test(id)) return false
  return getAiDb().prepare('DELETE FROM ai_media WHERE id = ? AND conversation_id IS NULL AND session_id = ?').run(id, sessionId).changes > 0
}

/** One file with its bytes (the serving route), or null. */
export function getMediaFile(id: unknown): (MediaView & { conversationId: string | null; sessionId: string | null; sha256: string; bytes: Buffer }) | null {
  if (typeof id !== 'string' || !MEDIA_ID_RE.test(id)) return null
  const r = getAiDb().prepare(`SELECT ${VIEW_COLUMNS}, bytes FROM ai_media WHERE id = ?`).get(id) as (MediaRow & { bytes: Buffer }) | undefined
  if (!r) return null
  return { ...viewOf(r), conversationId: r.conversation_id, sessionId: r.session_id, sha256: r.sha256, bytes: r.bytes }
}

export type PendingCheck = { ok: true; files: MediaView[]; texts: Array<{ view: MediaView; text: string }> } | { ok: false; error: string; field?: string }

/** The pending files a message names, in order: each exists, is this session's, and is not sent yet. */
export function pendingFiles(ids: readonly string[], sessionId: string): PendingCheck {
  if (ids.length > MEDIA_PER_MESSAGE) return { ok: false, error: `Attach at most ${MEDIA_PER_MESSAGE} files to one message.` }
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'A file is attached twice.' }
  const db = getAiDb()
  const files: MediaView[] = []
  const texts: Array<{ view: MediaView; text: string }> = []
  let textBytes = 0
  for (const id of ids) {
    if (!MEDIA_ID_RE.test(id)) return { ok: false, error: 'Not a file id.' }
    const r = db.prepare(`SELECT ${VIEW_COLUMNS} FROM ai_media WHERE id = ?`).get(id) as MediaRow | undefined
    if (!r || r.conversation_id !== null || r.session_id !== sessionId) return { ok: false, error: 'A file of this message is gone (files not sent within a day are deleted). Attach it again.' }
    const view = viewOf(r)
    files.push(view)
    if (r.kind === 'text') {
      textBytes += r.size
      if (textBytes > TEXT_PER_MESSAGE_BYTES) return { ok: false, error: 'The text files of one message can be at most 768 KB together.' }
      const row = db.prepare('SELECT bytes FROM ai_media WHERE id = ?').get(id) as { bytes: Buffer }
      texts.push({ view, text: row.bytes.toString('utf8') })
    }
  }
  return { ok: true, files, texts }
}

/** Bytes of model-visible files a conversation holds already. */
export function conversationMediaBytes(conversationId: string): number {
  const r = getAiDb().prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM ai_media WHERE conversation_id = ? AND kind != 'text'").get(conversationId) as { bytes: number }
  return Number(r.bytes) || 0
}

class ClaimShort extends Error {}

/**
 * The message that carries them claims its files: from now on they belong to
 * the conversation. All or nothing: if any one is gone (removed from another
 * tab), none is claimed and every file stays pending. Returns how many were
 * claimed: `ids.length` or 0.
 */
export function claimMedia(ids: readonly string[], conversationId: string, sessionId: string): number {
  if (!ids.length) return 0
  const db = getAiDb()
  const stmt = db.prepare('UPDATE ai_media SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL AND session_id = ?')
  try {
    return db.transaction(() => {
      const n = ids.reduce((sum, id) => sum + stmt.run(conversationId, id, sessionId).changes, 0)
      if (n !== ids.length) throw new ClaimShort()
      return n
    })()
  } catch (err) {
    if (err instanceof ClaimShort) return 0
    throw err
  }
}

/** Delete a conversation's files (a message the provider refused with them: it is not kept, and neither are they). */
export function deleteConversationMedia(conversationId: string, ids: readonly string[]): number {
  if (!ids.length) return 0
  const db = getAiDb()
  const stmt = db.prepare('DELETE FROM ai_media WHERE conversation_id = ? AND id = ?')
  return db.transaction(() => ids.reduce((n, id) => n + stmt.run(conversationId, id).changes, 0))()
}

/**
 * An image of the site's media library, as a model may see it (a `media`
 * chip, when the model takes images): the stored original read from
 * public/uploads, normalised like an upload. Null when the name is not an
 * upload, the file is not here (only on R2) or not an image.
 */
export async function loadSiteImage(name: string): Promise<ParsedMedia | null> {
  if (!isValidUploadName(name)) return null
  const dir = uploadsDir()
  const file = path.join(dir, name)
  if (path.dirname(file) !== dir) return null
  let buf: Buffer
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > LIMITS.image) return null
    buf = await fs.readFile(file)
  } catch {
    return null
  }
  if (!sniffImageType(buf)) return null
  try {
    const img = await normalizeImage(buf)
    return { kind: 'image', mime: img.mime, name, bytes: img.bytes, width: img.width, height: img.height, pages: null, durationMs: null, chars: null }
  } catch {
    return null
  }
}

/** Store a file straight into a conversation (a site image a chip named). */
export function storeConversationMedia(m: ParsedMedia, conversationId: string, now = Date.now()): MediaView {
  const id = newMediaId()
  const sha256 = crypto.createHash('sha256').update(m.bytes).digest('hex')
  getAiDb()
    .prepare(
      `INSERT INTO ai_media (id, conversation_id, session_id, kind, mime, name, bytes, size, sha256, width, height, pages, duration_ms, chars, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, conversationId, m.kind, m.mime, m.name, m.bytes, m.bytes.length, sha256, m.width, m.height, m.pages, m.durationMs, m.chars, now)
  return { id, kind: m.kind, mime: m.mime, name: m.name, size: m.bytes.length, width: m.width, height: m.height, pages: m.pages, durationMs: m.durationMs, chars: m.chars }
}

/** Files of a conversation (newest last). */
export function mediaOfConversation(conversationId: string): MediaView[] {
  return (getAiDb().prepare(`SELECT ${VIEW_COLUMNS} FROM ai_media WHERE conversation_id = ? ORDER BY created_at, id`).all(conversationId) as MediaRow[]).map(viewOf)
}

// ── What a model is sent ─────────────────────────────────────────────────

export type { MediaPart }

/** Does a native turn carry file placeholders? */
export function hasMediaRefs(native: unknown): boolean {
  if (isRef(native)) return true
  if (Array.isArray(native)) return native.some(hasMediaRefs)
  if (native && typeof native === 'object') return Object.values(native as Record<string, unknown>).some(hasMediaRefs)
  return false
}

export class MediaMissing extends Error {
  constructor(id: string) {
    super(`A file of this conversation is missing (${id}).`)
    this.name = 'MediaMissing'
  }
}

/** Replace the placeholders of one native turn with the files' data. `load` reads a file's mime and bytes. */
export function fillMediaRefs(native: unknown, load: (id: string) => { mime: string; bytes: Buffer } | null): unknown {
  const walk = (v: unknown): unknown => {
    if (isRef(v)) {
      const f = load(v.$aiMedia)
      if (!f) throw new MediaMissing(v.$aiMedia)
      const b64 = f.bytes.toString('base64')
      return v.enc === 'base64' ? b64 : `data:${f.mime.split(';')[0]};base64,${b64}`
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(native)
}

/**
 * The history as the model is sent it: placeholders filled in, only in turns
 * the server composed (role `user`). A model-written turn is replayed as it
 * came, whatever it contains.
 */
export function hydrateHistory(turns: ReadonlyArray<{ role: string; native: NativeTurn }>): NativeTurn[] {
  const cache = new Map<string, { mime: string; bytes: Buffer } | null>()
  const db = getAiDb()
  const load = (id: string) => {
    if (!cache.has(id)) {
      const r = db.prepare('SELECT mime, bytes FROM ai_media WHERE id = ?').get(id) as { mime: string; bytes: Buffer } | undefined
      cache.set(id, r ?? null)
    }
    return cache.get(id) ?? null
  }
  return turns.map((t) => (t.role === 'user' && hasMediaRefs(t.native) ? (fillMediaRefs(t.native, load) as NativeTurn) : t.native))
}

// ── What a model takes ───────────────────────────────────────────────────

/** Whether a model takes each kind of file: true / false when known (its Test, or Claude's Models API), null when not. */
export type MediaSupport = { image: boolean | null; pdf: boolean | null; audio: boolean | null }

/** What a conversation froze, with anything it did not know then filled in from the model's latest Test. */
export function mergeSupport(frozen: MediaSupport | null | undefined, current: MediaSupport): MediaSupport {
  return { image: frozen?.image ?? current.image, pdf: frozen?.pdf ?? current.pdf, audio: frozen?.audio ?? current.audio }
}

export const UNKNOWN_SUPPORT: MediaSupport = Object.freeze({ image: null, pdf: null, audio: null })

const tri = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null)

/**
 * What a model takes, from what was recorded about it. Audio never goes over
 * the Claude or Responses wires (neither takes it); everything else comes
 * from the model's Test observations, or Claude's capabilities.
 */
export function mediaSupportOf(wire: Wire, observations: Record<string, unknown> | null | undefined, claude?: { imageInput?: boolean | null; pdfInput?: boolean | null } | null): MediaSupport {
  const o = observations ?? {}
  const image = wire === 'anthropic' ? tri(claude?.imageInput ?? o.imageInput) : tri(o.imageInput)
  const pdf = wire === 'anthropic' ? tri(claude?.pdfInput ?? o.pdfInput ?? claude?.imageInput) : tri(o.pdfInput)
  const audio = wire === 'chat' ? tri(o.audioInput) : false
  return { image, pdf, audio }
}

const KIND_WORDS: Record<Exclude<MediaKind, 'text'>, string> = { image: 'images', pdf: 'PDFs', audio: 'audio' }

/** Why a model cannot be sent these files, or null when it can (or nobody knows yet: then it is tried). */
export function unsupportedReason(files: readonly MediaView[], support: MediaSupport, modelName: string): string | null {
  for (const kind of ['image', 'pdf', 'audio'] as const) {
    if (!files.some((f) => f.kind === kind)) continue
    if (support[kind] === false) {
      return kind === 'audio'
        ? `${modelName} does not take audio. Dictate instead, or start a new chat with a model that takes audio.`
        : `${modelName} does not take ${KIND_WORDS[kind]}. Start a new chat with a model that does.`
    }
  }
  return null
}

/** The parts of a message an adapter sends as content (text files are quoted into its text instead). */
export function partsOf(files: readonly MediaView[]): MediaPart[] {
  return files.filter((f): f is MediaView & { kind: MediaPart['kind'] } => f.kind !== 'text').map((f) => ({ id: f.id, kind: f.kind, mime: f.mime, name: f.name }))
}
