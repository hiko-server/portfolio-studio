import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { Button, type ButtonProps } from '@chakra-ui/react'
import { FiMessageSquare } from 'react-icons/fi'
import { isImeComposing } from '../../../lib/keyboardShortcuts'
import { KbdHint, useIsMac } from '../shell/ui'
import { ASK_COPY } from './askCopy'
import { AskAiContext, useAskAi, type AskAiValue, type AskChip, type DocHost, type EditorHost, type OpenOptions } from './askContext'

// The panel and everything it renders (the conversation, the cards, ChatMarkdown) load on first open (§8.6, §11).
const AskPanel = dynamic(() => import('./AskPanel'), { ssr: false })

/**
 * Is AI access on for this site? Asked once per page load (GET
 * /api/admin/ai/summary), so every Ask AI button on a page shares the
 * answer. Off, unreadable or signed out: no entry point shows.
 */
let availability: Promise<boolean> | null = null
function aiAvailable(): Promise<boolean> {
  availability ??= fetch('/api/admin/ai/summary', { cache: 'no-store', credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) return false
      const json = (await res.json()) as { access?: { enabled?: boolean; blocked?: unknown } }
      return json.access?.enabled === true && !json.access.blocked
    })
    .catch(() => false)
  return availability
}

/** ⌘J / Ctrl+J (PRODUCT §4.7): the key, never during an input method's composition. */
function isAskShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j' && !isImeComposing(e)
}

export type AskHostConfig = {
  /** What the page attaches by default (the post being edited, the home page, the CV…). */
  chips: AskChip[]
  /** An open post, case-study or page editor: lends its state and takes suggestions (the editor bridge). */
  editor?: EditorHost | null
  /** A home or CV editor: its proposals wait while it has unsaved edits. */
  doc?: DocHost | null
  /** What the panel's intro calls the page ("this post"). */
  label?: string
  /** One conversation per page, kept for this tab: the post's ref, "home"… */
  scope: string
}

/**
 * Ask AI on a page (design §7.8, §8.6; PRODUCT §5), as a hook: the page owns
 * the panel's state, opens it from its own handlers (`value.open(...)`) and
 * renders `element` once inside `<AskAiProvider value={value}>`, which its
 * entry points (AskAiButton) read. ⌘J / Ctrl+J toggles the panel while AI
 * access is on. Nothing opens by itself and nothing shows while AI access
 * is off. The panel loads on first open (dynamic, no SSR) and stays
 * mounted after, so a conversation survives closing and reopening it.
 */
export function useAskAiHost({ chips, editor = null, doc = null, label, scope }: AskHostConfig): { value: AskAiValue; element: ReactNode } {
  const [available, setAvailable] = useState(false)
  const [isOpen, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [attached, setAttached] = useState<AskChip[]>(chips)
  const [request, setRequest] = useState<{ prompt?: string; changeId?: string; n: number }>({ n: 0 })
  const opener = useRef<HTMLElement | null>(null)
  const chipsKey = JSON.stringify(chips)
  const defaults = useRef(chips)
  defaults.current = chips

  useEffect(() => {
    let alive = true
    void aiAvailable().then((on) => {
      if (alive) setAvailable(on)
    })
    return () => {
      alive = false
    }
  }, [])

  // The page's own chip follows the page (a new slug, a saved version): reset what is attached while closed.
  useEffect(() => {
    if (!isOpen) setAttached(defaults.current)
    // chipsKey is the content of `chips`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chipsKey])

  const remember = () => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) opener.current = document.activeElement
  }
  const open = useCallback((opts: OpenOptions = {}) => {
    remember()
    setAttached(opts.chips ?? defaults.current)
    setRequest((r) => ({ prompt: opts.prompt, changeId: opts.changeId, n: r.n + 1 }))
    setMounted(true)
    setOpen(true)
  }, [])
  const close = useCallback(() => {
    setOpen(false)
    // Back to what opened it, if it is still on the page.
    const el = opener.current
    if (el && el.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }))
  }, [])
  const toggle = useCallback(() => {
    if (isOpen) return close()
    remember()
    setMounted(true)
    setOpen(true)
  }, [isOpen, close])

  useEffect(() => {
    if (!available) return
    const onKey = (e: KeyboardEvent) => {
      if (!isAskShortcut(e) || e.repeat) return
      // Ctrl+J is Downloads in Chrome on Windows and Linux: taken here only while Ask AI is on.
      e.preventDefault()
      toggle()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [available, toggle])

  const value = useMemo(() => ({ available, isOpen, open, close, toggle }), [available, isOpen, open, close, toggle])
  const element =
    mounted && available ? <AskPanel isOpen={isOpen} onClose={close} chips={attached} onChips={setAttached} request={request} editor={editor} doc={doc} label={label} scope={scope} /> : null
  return { value, element }
}

/** What the entry points under a page read (useAskAi). */
export const AskAiProvider = AskAiContext.Provider

/** The host as a wrapper, for a page whose entry points are all AskAiButtons. */
export function AskAiHost({ children, ...config }: AskHostConfig & { children: ReactNode }) {
  const { value, element } = useAskAiHost(config)
  return (
    <AskAiProvider value={value}>
      {children}
      {element}
    </AskAiProvider>
  )
}

/** The keys of the shortcut on this platform. */
export function useAskKeys(): string[] {
  return useIsMac() ? ['⌘', 'J'] : ['Ctrl', 'J']
}

/**
 * The "Ask AI" button of an entry point. Renders nothing while AI access is
 * off. `options` say what it attaches and prefills; `hint` shows the ⌘J
 * hint beside it (title bars).
 */
export function AskAiButton({
  options,
  hint = false,
  disabledReason,
  isDisabled = false,
  ...rest
}: { options?: OpenOptions | (() => OpenOptions); hint?: boolean; disabledReason?: string | null } & Omit<ButtonProps, 'onClick'>) {
  const ask = useAskAi()
  const keys = useAskKeys()
  if (!ask.available) return null
  return (
    <>
      {hint ? <KbdHint keys={keys} /> : null}
      <Button
        size="sm"
        variant="ghost"
        color="page.fg-secondary"
        _hover={{ color: 'page.fg', bg: 'page.bg-overlay' }}
        leftIcon={<FiMessageSquare aria-hidden />}
        aria-keyshortcuts={keys[0] === '⌘' ? 'Meta+J' : 'Control+J'}
        aria-expanded={ask.isOpen}
        title={disabledReason ?? ASK_COPY.shortcut(keys.join(''))}
        isDisabled={!!disabledReason || isDisabled}
        onClick={() => ask.open(typeof options === 'function' ? options() : options)}
        data-ask-ai=""
        {...rest}
      >
        {ASK_COPY.button}
      </Button>
    </>
  )
}
