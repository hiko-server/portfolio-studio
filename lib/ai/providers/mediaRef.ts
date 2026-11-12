/**
 * The placeholder an adapter puts where its wire wants a file's data
 * (lib/ai/media fills it in just before each model call). Tiny and
 * dependency-free, so the adapters stay free of the media store.
 */

export const MEDIA_ID_RE = /^m_[A-Za-z0-9_-]{22}$/

export type MediaRef = { $aiMedia: string; enc: 'base64' | 'data-url' }

export const mediaRef = (id: string, enc: MediaRef['enc']): MediaRef => ({ $aiMedia: id, enc })

/** Exactly a placeholder: two keys, a file id and an encoding. */
export function isMediaRef(v: unknown): v is MediaRef {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return Object.keys(o).length === 2 && typeof o.$aiMedia === 'string' && MEDIA_ID_RE.test(o.$aiMedia) && (o.enc === 'base64' || o.enc === 'data-url')
}
