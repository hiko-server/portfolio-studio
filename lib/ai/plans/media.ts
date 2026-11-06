import { assetExists } from '../../media/library'
import { cleanMeta, type MediaMetaInput } from '../../media/meta'
import { readMediaMeta } from '../../media/metaStore'
import { isValidUploadName } from '../../security/uploadName'
import { isVariantName } from '../../uploadVariants'
import { referencedAnywhere, uploadFacts, viewUploads } from '../publicMedia'
import type { ToolRefusal } from '../toolTypes'
import { canonicalJson, type WritePlan } from './types'

/**
 * Plan of `set_media_text` (pure, design §4.2): the default alt texts and
 * captions of one upload, which the editors offer when the image is
 * inserted. No public page reads them until a human inserts the image or
 * an approved alt-text fill copies them (stage M3), so the write is
 * draft-safe.
 *
 * Only an upload the caller can see is a target: one that a public page,
 * a draft or unpublished changes use (lib/ai/publicMedia viewUploads), or
 * one nothing refers to at all (list_media `unused`). An upload referred
 * to only by something hidden or private — a hidden home photo, the CV's
 * PDF-only photo — answers exactly like a name that does not exist.
 */

export type SetMediaTextArgs = {
  name: string
  alt?: string
  alt_zh?: string
  caption?: string
  caption_zh?: string
  expected_updated_at: number
  rationale?: string
}

const FIELD_OF = { alt: 'alt', alt_zh: 'altZh', caption: 'caption', caption_zh: 'captionZh' } as const

const NOT_FOUND: ToolRefusal = { ok: false, code: 'NOT_FOUND', message: 'There is no image with that name. Find names with list_media.' }

/** Is `name` an upload this caller (with draft access) can see? */
function visibleUpload(name: string): boolean {
  if (viewUploads({ drafts: true }).has(name)) return true
  return uploadFacts().has(name) && !referencedAnywhere().has(name)
}

const textsJson = (t: { alt: string; altZh: string; caption: string; captionZh: string }) => JSON.stringify(JSON.parse(canonicalJson(t)), null, 2)

export function planSetMediaText(args: SetMediaTextArgs): WritePlan | ToolRefusal {
  const name = args.name
  if (!isValidUploadName(name) || isVariantName(name) || !assetExists(name) || !visibleUpload(name)) return NOT_FOUND
  const input: MediaMetaInput = {}
  const fields: Record<string, string> = {}
  for (const [arg, field] of Object.entries(FIELD_OF) as Array<[keyof typeof FIELD_OF, (typeof FIELD_OF)[keyof typeof FIELD_OF]]>) {
    const v = args[arg]
    if (typeof v === 'string') {
      input[field] = v
      fields[field] = v
    }
  }
  const current = readMediaMeta().doc.items[name] ?? null
  const version = current?.updatedAt ?? 0
  if (version !== args.expected_updated_at) {
    return { ok: false, code: 'VERSION_CONFLICT', message: 'These texts changed since they were read: read them again with list_media (texts_version).', data: { current_version: version } }
  }
  const before = current ? { alt: current.alt, altZh: current.altZh, caption: current.caption, captionZh: current.captionZh } : { alt: '', altZh: '', caption: '', captionZh: '' }
  const after = cleanMeta(input, before)
  if (canonicalJson(after) === canonicalJson(before)) return { ok: false, code: 'NO_VISIBLE_CHANGE', message: 'The texts are already exactly that. Nothing was saved.' }
  return {
    kind: 'media.texts',
    risk: 'draft',
    target: { kind: 'media', ref: name },
    baseVersion: String(version),
    args: { name, texts: fields, expected_updated_at: version },
    rationale: args.rationale ?? null,
    before: { kind: 'media', name, texts: current ? before : null, updatedAt: version },
    preview: {
      kind: 'media.texts',
      risk: 'draft',
      title: `Default texts of image ${name}`,
      documents: [{ ref: `media/${name}`, label: `Default alt text and caption of image ${name}`, publicUrl: null, format: 'json', before: textsJson(before), after: textsJson(after) }],
      effects: { publicPaths: [], schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    held: null,
    check: { kind: 'texts', fields, before },
    audit: { entry: { action: 'media.texts', area: 'media', target: name, summary: `Updated the default alt text and caption of image “${name}”` } },
    editUrl: `/admin/media?open=${encodeURIComponent(name)}`,
  }
}
