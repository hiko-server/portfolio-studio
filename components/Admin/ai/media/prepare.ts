import type { MediaKind, MediaView } from '../types'

/**
 * Files for the assistant, made ready in the browser before they leave it
 * (the server checks and re-encodes them again: lib/ai/media).
 *
 *   image  decoded upright, scaled to at most 2048 px on the long edge and
 *          re-encoded (JPEG, or PNG when it has transparency): a 12 MP phone
 *          photo leaves as a few hundred KB, and its EXIF (GPS, camera) never
 *          leaves at all. A format this browser cannot decode (HEIC outside
 *          Safari) is refused with a reason.
 *   audio  a recording or an audio file, decoded and resampled to 16 kHz
 *          mono WAV: the format every audio-taking model accepts.
 *   pdf, text  sent as they are.
 *
 * Uploads use XMLHttpRequest for its upload progress (same origin: CSP
 * connect-src 'self'), JSON like every admin write.
 */

export const MAX_FILES = 10
export const IMAGE_EDGE = 2048
const MAX_AUDIO_SECONDS = 5 * 60

const TEXT_EXT =
  /\.(txt|text|md|markdown|mdx|rst|adoc|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|log|xml|svg|html?|css|scss|less|m?[jt]sx?|c[jt]s|vue|svelte|astro|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|pl|lua|r|sql|sh|bash|zsh|fish|ps1|bat|gradle|properties|tex|bib|srt|vtt|diff|patch)$/i

/** What a picked file is, by its type and name (null: not something the assistant takes). */
export function classify(file: { type: string; name: string }): MediaKind | null {
  const type = (file.type || '').toLowerCase()
  const name = file.name || ''
  if (type.startsWith('image/') && type !== 'image/svg+xml') return 'image'
  if (/\.(heic|heif|avif|jpe?g|png|webp|gif|bmp)$/i.test(name) && !type) return 'image'
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf'
  if (type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac)$/i.test(name)) return 'audio'
  if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || TEXT_EXT.test(name) || /^(dockerfile|makefile)$/i.test(name)) return 'text'
  return null
}

export class PrepareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrepareError'
  }
}

const baseName = (name: string) => name.replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'file'

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new PrepareError('The image could not be encoded.'))), type, quality))
}

async function decodeImage(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() }
    } catch {
      // Fall through to <img>, which some browsers decode more widely.
    }
  }
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch {
    URL.revokeObjectURL(url)
    throw new PrepareError('This browser can’t read this image. Save it as JPEG or PNG and attach it again.')
  }
}

/** Does any pixel of a small rendering show transparency? */
function hasAlpha(source: CanvasImageSource, width: number, height: number): boolean {
  const c = document.createElement('canvas')
  const scale = Math.min(1, 96 / Math.max(width, height))
  c.width = Math.max(1, Math.round(width * scale))
  c.height = Math.max(1, Math.round(height * scale))
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  ctx.drawImage(source, 0, 0, c.width, c.height)
  const data = ctx.getImageData(0, 0, c.width, c.height).data
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true
  return false
}

/** An image scaled and re-encoded, without metadata. */
export async function prepareImage(blob: Blob, name: string): Promise<{ blob: Blob; name: string; width: number; height: number }> {
  const img = await decodeImage(blob)
  try {
    const scale = Math.min(1, IMAGE_EDGE / Math.max(img.width, img.height))
    const width = Math.max(1, Math.round(img.width * scale))
    const height = Math.max(1, Math.round(img.height * scale))
    const alpha = /png|webp|gif/i.test(blob.type) && hasAlpha(img.source, img.width, img.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new PrepareError('The image could not be prepared.')
    if (!alpha) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
    }
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img.source, 0, 0, width, height)
    const out = await canvasToBlob(canvas, alpha ? 'image/png' : 'image/jpeg', alpha ? undefined : 0.88)
    return { blob: out, name: `${baseName(name)}.${alpha ? 'png' : 'jpg'}`, width, height }
  } finally {
    img.close()
  }
}

/** 16-bit PCM WAV of mono samples. */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

/** Any audio this browser decodes, as 16 kHz mono WAV. */
export async function prepareAudio(blob: Blob, name: string): Promise<{ blob: Blob; name: string; durationMs: number }> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx || typeof OfflineAudioContext === 'undefined') throw new PrepareError('This browser can’t prepare audio.')
  const ctx = new Ctx()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
  } catch {
    throw new PrepareError('This browser can’t read this audio file.')
  } finally {
    void ctx.close()
  }
  if (decoded.duration > MAX_AUDIO_SECONDS) throw new PrepareError('Audio clips can be at most 5 minutes long.')
  const rate = 16_000
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return { blob: encodeWav(rendered.getChannelData(0), rate), name: `${baseName(name)}.wav`, durationMs: Math.round(decoded.duration * 1000) }
}

export function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new PrepareError('The file could not be read.'))
    r.readAsDataURL(blob)
  })
}

export class UploadError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.name = 'UploadError'
    this.status = status
    this.code = code
  }
}

/** Upload one prepared file; `onProgress` gets 0–1. Resolves with the server's view of it. */
export function uploadMedia(blob: Blob, name: string, opts: { onProgress?: (p: number) => void; signal?: AbortSignal } = {}): Promise<MediaView> {
  return readAsDataUrl(blob).then(
    (dataUrl) =>
      new Promise<MediaView>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', '/api/admin/ai/uploads')
        xhr.setRequestHeader('Content-Type', 'application/json')
        xhr.withCredentials = true
        xhr.responseType = 'json'
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total)
        }
        xhr.onload = () => {
          const body = (xhr.response ?? {}) as { media?: MediaView; error?: string; code?: string }
          if (xhr.status === 201 && body.media) return resolve(body.media)
          reject(new UploadError(body.error ?? (xhr.status === 413 ? 'This file is too large.' : `Upload failed (HTTP ${xhr.status}).`), xhr.status, body.code ?? null))
        }
        xhr.onerror = () => reject(new UploadError('The connection dropped while uploading.', 0, 'NETWORK'))
        xhr.onabort = () => reject(new UploadError('Upload cancelled.', 0, 'ABORTED'))
        opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
        xhr.send(JSON.stringify({ filename: name, dataUrl }))
      }),
  )
}

/** Take a pending file back (best effort: unsent files are deleted after a day anyway). */
export function deleteUpload(id: string): void {
  void fetch('/api/admin/ai/uploads', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), credentials: 'same-origin', keepalive: true }).catch(() => {})
}

export const mediaUrl = (id: string, download = false) => `/api/admin/ai/media/${encodeURIComponent(id)}${download ? '?download=1' : ''}`

/** "1.2 MB", "820 KB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** "0:42", "3:05". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A capture or paste with no useful name: "photo-2026-11-12-1530.jpg". */
export function stampedName(prefix: string, ext: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${prefix}-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`
}
