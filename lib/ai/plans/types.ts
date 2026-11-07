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

export type ItemBeforeState = {
  kind: 'item'
  collection: 'blog' | 'work'
  slug: string
  live: { frontmatter: Record<string, unknown>; body: string; updatedAt: number } | null
  pending: { frontmatter: Record<string, unknown>; body: string; updatedAt: number; baseUpdatedAt: number } | null
}

/**
 * The complete state a write replaces — what an undo restores, and the state
 * before AI first touched a target (kept 90 days, §3.2): an item's live and
 * pending rows, a page, the whole home or CV document, an upload's texts or
 * file facts, or every document of a change that touches many. Never sent
 * to a browser or a model.
 */
export type BeforeState =
  | ItemBeforeState
  | { kind: 'media'; name: string; texts: { alt: string; altZh: string; caption: string; captionZh: string } | null; updatedAt: number }
  | { kind: 'page'; name: string; page: { frontmatter: Record<string, unknown>; body: string; updatedAt: number } | null }
  | { kind: 'doc'; doc: 'home' | 'cv'; value: unknown; version: number }
  | { kind: 'upload'; name: string; exists: boolean }
  | { kind: 'documents'; documents: BeforeState[] }

/**
 * One document of a change that moves or rewrites text the owner already
 * has (publishing, a restore, a tag change, a content fix, an alt-text
 * fill): lib/ai/validate lists what it adds — external links, player
 * embeds, zero-width characters — and refuses what no AI change may add.
 */
export type CheckedDocument =
  | {
      format: 'mdx'
      frontmatter: Record<string, unknown>
      body: string
      /** What it replaces (the state as it is now, or what is public now); null for nothing. */
      before: { frontmatter: Record<string, unknown>; body: string } | null
      /**
       * True when the server rewrote the text (a fix, a filled alt text): it must compile and may add no remote
       * image or invisible character. False when it only moves the owner's stored text (publish, restore).
       */
      rewritten: boolean
    }
  | {
      format: 'json'
      /** Every text value as it would be stored, and as it is now. */
      strings: string[]
      beforeStrings: string[]
      /** Link targets as the site prints them, after and before. */
      links: string[]
      beforeLinks: string[]
      /** Image sources, after and before. */
      images: string[]
      beforeImages: string[]
      rewritten: boolean
    }

/** What validateAiWrite checks of a write (lib/ai/validate). */
export type AiWriteSubject =
  | {
      kind: 'item'
      /** A post, a case study, or a single page (/now, /uses, the bios). */
      collection: 'blog' | 'work' | 'page'
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
  | {
      kind: 'documents'
      documents: CheckedDocument[]
      /** Addresses outside any document the change adds or makes the server contact (an image to import): listed. */
      extraLinks?: string[]
    }

export type WritePlan = {
  /** 'item.create', 'item.edit-draft', 'item.edit-pending', 'item.edit-held', 'media.texts', and the proposal kinds. */
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
  /**
   * Only the owner's approval applies it: every proposal (risk live or destructive). A draft-safe write is
   * applied at once unless it is held or the owner asked to approve drafts too.
   */
  proposal?: boolean
  /**
   * 'editor': the write goes to the owner's open editor (§7.8) — a suggestion the owner applies and saves there;
   * nothing is written to the store. Only plans of the target an assistant run is attached to.
   */
  sink?: 'editor'
  /** What validateAiWrite checks. */
  check: AiWriteSubject
  /** The write as its route twin would describe it in the activity log. */
  audit: AiWrite
  /** Where the owner edits the target. */
  editUrl: string
  /**
   * What the approval's executor writes, computed from `args` and the content as it is now (a merged document,
   * resolved texts) — the values the preview was built from. Never stored: the approval runs the plan again.
   */
  exec?: Record<string, unknown>
}

/** JSON with sorted keys and no undefined values: the one serialisation every hash uses. */
export const canonicalJson = (value: unknown): string => stableStringify(value)

export const sha256Hex = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** The hash an owner's browser must send back to approve exactly this preview (§5.3). */
export const previewSha256 = (preview: Preview): string => sha256Hex(canonicalJson(preview))
