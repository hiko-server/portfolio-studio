import { targetRef } from './editorBridge'
import type { AskChip, EditorHost } from './askContext'

/**
 * What a message carries besides its words (lib/ai/attachments): the chips,
 * and from the open editor its current state — so the run is attached to
 * that editor (§7.8). `withSelection` false: a Retry or Continue never
 * repeats a selection.
 */
export function attachmentsOf(chips: readonly AskChip[], editor: EditorHost | null, withSelection = true): unknown[] {
  const out: unknown[] = []
  for (const c of chips) {
    if (c.kind === 'item' || c.kind === 'page') {
      const ref = c.kind === 'item' ? `${c.collection}/${c.slug}` : c.name
      if (c.editor && editor && editor.version && targetRef(editor.target) === ref) {
        const doc = editor.current()
        out.push({ kind: c.kind, ref, version: editor.version, dirty: editor.dirty, state: { frontmatter: JSON.parse(JSON.stringify(doc.frontmatter ?? {})), body: doc.body } })
      } else out.push({ kind: c.kind, ref, ...(c.version ? { version: c.version } : {}) })
    } else if (c.kind === 'home') out.push({ kind: 'home', ref: 'home', ...(c.version ? { version: c.version } : {}) })
    else if (c.kind === 'cv') out.push({ kind: 'cv', ref: c.lang, ...(c.version ? { version: c.version } : {}) })
    else if (c.kind === 'media') out.push({ kind: 'media', ref: c.name })
    else if (c.kind === 'selection' && withSelection) out.push({ kind: 'selection', ref: c.from, state: { text: c.text } })
  }
  return out
}
