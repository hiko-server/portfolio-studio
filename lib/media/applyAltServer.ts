import { isValidUploadName } from '../security/uploadName'
import { isVariantName } from '../uploadVariants'
import { rebuildUsage } from './library'
import { readMediaMeta } from './metaStore'
import { defaultAltTransform, type DefaultAlt } from './applyAlt'
import { rewriteDocuments, type RewriteRun } from './docRewrite'

/**
 * "Use the default alt text where it is missing" (H7) — SERVER-ONLY. Every
 * post, case study (live version and unpublished changes) and page that
 * shows the upload without an alt text (or with a file name as alt) gets
 * the image's default — the English one in English documents, the Chinese
 * one in Chinese documents (a document in another language, or without a
 * default in its language, is left alone). Snapshotted first, like a save.
 *
 * `expected`: the default texts the caller showed (an approved AI proposal,
 * lib/ai/apply). They must still be the image's texts — otherwise nothing
 * is written (409) — and exactly they are written.
 */

export type ApplyAltOutcome = ({ ok: true; places: number } & RewriteRun) | { ok: false; status: 400 | 409; error: string }

export async function applyDefaultAlt(name: string, expected?: DefaultAlt): Promise<ApplyAltOutcome> {
  if (!isValidUploadName(name) || isVariantName(name)) return { ok: false, status: 400, error: 'Not an upload name' }
  const meta = readMediaMeta().doc.items[name]
  if (!meta?.alt && !meta?.altZh) return { ok: false, status: 400, error: 'Write a default alt text first' }
  if (expected && (expected.alt !== meta.alt || expected.altZh !== meta.altZh)) {
    return { ok: false, status: 409, error: 'The default alt text of this image changed since this was proposed' }
  }
  const texts: DefaultAlt = expected ?? { alt: meta.alt, altZh: meta.altZh }
  const run = await rewriteDocuments(defaultAltTransform(name, texts))
  rebuildUsage(true)
  return { ok: true, places: run.rewrites.reduce((n, r) => n + r.references, 0), ...run }
}
