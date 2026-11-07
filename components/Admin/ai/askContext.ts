import { createContext, useContext } from 'react'
import type { EditorDoc, EditorTarget } from './editorBridge'

/**
 * The contexts Ask AI shares (design §7.8, §8.6). Tiny on purpose: an
 * editor page imports this with its "Ask AI" button, and the panel —
 * loaded on first open — reads the same contexts.
 */

/** A chip: a typed reference attached to the next message (PRODUCT §4.6), or text selected in the editor. */
export type AskChip =
  | { kind: 'item'; collection: 'blog' | 'work'; slug: string; version?: string | null; editor?: boolean }
  | { kind: 'page'; name: 'now' | 'uses' | 'about' | 'about-zh'; version?: string | null; editor?: boolean }
  | { kind: 'home'; version?: string | null }
  | { kind: 'cv'; lang: 'en' | 'zh'; version?: string | null }
  | { kind: 'media'; name: string }
  | { kind: 'selection'; from: string; text: string }

/** What an open post, case-study or page editor lends the panel: the editor bridge (§7.8). */
export type EditorHost = {
  target: EditorTarget
  /** The version the editor loaded (null for a new, unsaved item: no bridge). */
  version: string | null
  dirty: boolean
  saving: boolean
  /** The document as the editor would save it now. */
  current: () => EditorDoc
  /** Put a whole document into the editor: it goes dirty, and Save writes it. */
  replace: (doc: EditorDoc) => void
  /** AI changes applied in this editor and not saved yet (the AI-touched state). */
  touched: readonly string[]
  markTouched: (id: string) => void
  unmarkTouched: (id: string) => void
}

/** A home or CV editor: not bridged in v1; its proposals wait while it has unsaved edits (§7.8). */
export type DocHost = { target: { kind: 'home' | 'cv'; ref: string }; dirty: boolean }

export type OpenOptions = {
  /** Replace the attached chips (the page's own chip comes back unless `chips` leaves it out). */
  chips?: AskChip[]
  /** Text put in the message box for the owner to send or change. */
  prompt?: string
  /** A waiting change "Open in editor" brought here (§8.2): shown first, ready to apply. */
  changeId?: string
}

export type AskAiValue = {
  /** AI access is on: the entry points show. */
  available: boolean
  isOpen: boolean
  open: (opts?: OpenOptions) => void
  close: () => void
  toggle: () => void
}

export const AskAiContext = createContext<AskAiValue>({ available: false, isOpen: false, open: () => {}, close: () => {}, toggle: () => {} })

/** The page's Ask AI: whether it is available, and how to open it. Outside a host, never available. */
export const useAskAi = (): AskAiValue => useContext(AskAiContext)

/** Inside the panel: the editor it is attached to and the document editor that hosts it, if any. */
export type PanelHost = { editor: EditorHost | null; doc: DocHost | null }

export const PanelHostContext = createContext<PanelHost>({ editor: null, doc: null })

export const usePanelHost = (): PanelHost => useContext(PanelHostContext)
