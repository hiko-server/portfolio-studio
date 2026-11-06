import crypto from 'node:crypto'
import { stableStringify } from '../../contentStore'
import type { AiWrite } from '../audit'
import type { Risk, ToolTarget } from '../toolTypes'

/**
 * What a write plan is (pure types and helpers, design §4.1, §5.3).
 *
 * A plan is computed from the stored arguments and the content as it is
 * now, and writes nothing. It says what the write would do (`kind`, `risk`,
 * the target and the version it was made from), what exactly would be
 * executed (`args`, canonical, with every value the server resolved), the
 * complete state it replaces (`before`, kept for undo), and the preview —
 * the one thing an owner sees and approves. The same function runs again at
 * approval (stage M3), so the card and the execution cannot differ.
 */

/** One document of a preview: its text before and after, complete. */
export type PreviewDocument = {
  /** 'blog/<slug>', 'work/<slug>', 'media/<name>', ... */
  ref: string
  /** Composed by the server from the action and the slug, never model text. */
  label: string
  publicUrl: string | null
  /** mdx: lib's documentText (frontmatter lines, then the body); json: canonical JSON. */
  format: 'mdx' | 'json'
  before: string
  after: string
}

export type PreviewEffects = {
  /** Public paths the change would regenerate (none for a draft-safe write). */
  publicPaths: string[]
  schedule: unknown | null
  deleted: boolean
  import: { url: string; host: string } | null
  hiddenValuesChanged: number | null
}

/** The canonical preview (§5.3): no timestamps, so the same content always hashes the same. */
export type Preview = {
  kind: string
  risk: Risk
  title: string
  documents: PreviewDocument[]
  /** Every new external link, in full, with why it deserves a second look. */
  newLinks: { url: string; flags: string[] }[]
  newEmbeds: string[]
  /** Zero-width characters the write adds outside joiner contexts. */
  zeroWidth: number
  effects: PreviewEffects
}

/** The complete state a write replaces: an item's live and pending rows, or an upload's texts. */
export type BeforeState =
  | {
      kind: 'item'
      collection: 'blog' | 'work'
      slug: string
      live: { frontmatter: Record<string, unknown>; body: string; updatedAt: number } | null
      pending: { frontmatter: Record<string, unknown>; body: string; updatedAt: number; baseUpdatedAt: number } | null
    }
  | { kind: 'media'; name: string; texts: { alt: string; altZh: string; caption: string; captionZh: string } | null; updatedAt: number }

/** What validateAiWrite checks of a write (lib/ai/validate). */
export type AiWriteSubject =
  | {
      kind: 'item'
      collection: 'blog' | 'work'
      /** Frontmatter keys the call sets or removes: each must be on the allow-list. */
      touchedKeys: string[]
      /** The frontmatter and body as they would be stored. */
      frontmatter: Record<string, unknown>
      body: string
      /** What the write replaces (the stored item, or the editor's state): what may stay. Null for a new item. */
      before: { frontmatter: Record<string, unknown>; body: string } | null
    }
  | {
      kind: 'texts'
      /** The fields the call sets, as given. */
      fields: Record<string, string>
      before: Record<string, string> | null
    }

export type WritePlan = {
  /** 'item.create', 'item.edit-draft', 'item.edit-pending', 'media.texts' (M3 adds the proposal kinds). */
  kind: string
  risk: Risk
  target: ToolTarget
  /** The version the write was made from (null for a new item). */
  baseVersion: string | null
  /** Canonical: what an approval executes; values the server resolved are stored here. */
  args: Record<string, unknown>
  rationale: string | null
  before: BeforeState
  /** The preview without its link lists, which validateAiWrite fills from the real parse. */
  preview: Omit<Preview, 'newLinks' | 'newEmbeds' | 'zeroWidth'>
  /** The item would reach someone without the owner's approval (§4.6). */
  held: { reason: 'scheduled'; publishAt: number } | { reason: 'review_link'; activeLinks: number } | null
  /** What validateAiWrite checks. */
  check: AiWriteSubject
  /** The write as its route twin would describe it in the activity log. */
  audit: AiWrite
  /** Where the owner edits the target. */
  editUrl: string
}

/** JSON with sorted keys and no undefined values: the one serialisation every hash uses. */
export const canonicalJson = (value: unknown): string => stableStringify(value)

export const sha256Hex = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** The hash an owner's browser must send back to approve exactly this preview (§5.3). */
export const previewSha256 = (preview: Preview): string => sha256Hex(canonicalJson(preview))
