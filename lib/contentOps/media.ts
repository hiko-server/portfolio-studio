import { assetExists } from '../media/library'
import type { MediaMetaInput } from '../media/meta'
import { saveMediaMeta } from '../media/metaStore'
import type { MediaMeta } from '../media/types'
import { isValidUploadName } from '../security/uploadName'
import { isVariantName } from '../uploadVariants'

/**
 * The default texts of an upload (alt text and caption, English and
 * Chinese) — the media library's "meta" save, shared by its admin route
 * (pages/api/admin/media) and any other server code that sets them, with
 * the route's checks carried along: the store itself (lib/media/metaStore)
 * accepts any key, and a name such as `constructor` passes the upload-name
 * pattern, so only an existing, original upload may get texts. SERVER-ONLY.
 *
 * The audit entry stays with the caller (it needs the request's session).
 */

/** The text fields a save may set; a field left out keeps its value. */
export const MEDIA_TEXT_FIELDS = ['alt', 'altZh', 'caption', 'captionZh'] as const

export type SaveMediaTextInput = {
  name: unknown
  /** The fields to set (each must be text); others are ignored. */
  texts: Readonly<Record<string, unknown>>
  /** The texts' version the form was opened with (0: none yet); a stale one is refused with the current texts. */
  expectedUpdatedAt?: unknown
}

export type SaveMediaTextResult =
  | { ok: true; meta: MediaMeta | null; r2Warning?: string }
  | { ok: false; status: 400; code: 'INVALID_NAME' | 'INVALID_TEXT'; error: string }
  | { ok: false; status: 404; code: 'NOT_FOUND'; error: string }
  | { ok: false; status: 409; code: 'CONFLICT'; error: string; current: MediaMeta | null }
  | { ok: false; status: 500; code: 'STORE_ERROR'; error: string }

export async function saveMediaText({ name, texts, expectedUpdatedAt }: SaveMediaTextInput): Promise<SaveMediaTextResult> {
  if (!isValidUploadName(name) || isVariantName(name)) return { ok: false, status: 400, code: 'INVALID_NAME', error: 'Invalid name' }
  const expected = typeof expectedUpdatedAt === 'number' && Number.isFinite(expectedUpdatedAt) ? Math.trunc(expectedUpdatedAt) : undefined
  const input: MediaMetaInput = {}
  for (const k of MEDIA_TEXT_FIELDS) {
    if (k in texts) {
      if (typeof texts[k] !== 'string') return { ok: false, status: 400, code: 'INVALID_TEXT', error: `${k} must be text` }
      input[k] = texts[k]
    }
  }
  if (!assetExists(name)) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'No such upload' }
  const out = await saveMediaMeta(name, input, expected)
  if (out.ok) return out
  if (out.status === 409) return { ok: false, status: 409, code: 'CONFLICT', error: out.error, current: out.current }
  return { ok: false, status: 500, code: 'STORE_ERROR', error: out.error }
}
