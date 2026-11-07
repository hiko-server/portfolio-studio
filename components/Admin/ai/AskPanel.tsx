import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import NextLink from 'next/link'
import { Global } from '@emotion/react'
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerOverlay,
  Flex,
  Heading,
  IconButton,
  Skeleton,
  Text,
  VisuallyHidden,
  useBreakpointValue,
} from '@chakra-ui/react'
import { FiExternalLink, FiPlus, FiX } from 'react-icons/fi'
import { MONO, SITE_HEADER_H, outlineButtonProps, primaryButtonProps } from '../shell/ui'
import { loginHref, readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { ASSISTANT_COPY } from './copy'
import { ASK_COPY } from './askCopy'
import Composer, { PinnedModel } from './Composer'
import ContextChips from './ContextChips'
import ContextPicker from './ContextPicker'
import MessageList from './MessageList'
import ChatChange from './ChatChange'
import { useRun } from './useRun'
import { lastUserText, type Transcript } from './runState'
import { defaultProvider, endAnnouncement, endView, modelStatusOf, statusLabel, usageLine, type EndAction } from './assistantFormat'
import { PanelHostContext, type AskChip, type DocHost, type EditorHost } from './askContext'
import { attachmentsOf } from './askAttachments'
import type { AiSummaryView, ChangeState, ConversationDetail, ProvidersAnswer } from './types'

const A = ASSISTANT_COPY
const K = ASK_COPY
/** The panel's width from lg (PRODUCT §5). */
export const ASK_PANEL_W = 440

class Unauthorized extends Error {}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
  if (res.status === 401) throw new Unauthorized()
  const json = await readJsonObject(res)
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
  return json as T
}

function readSession(key: string): string | null {
  try {
    const v = window.sessionStorage.getItem(key)
    return v && /^c_[A-Za-z0-9_-]{4,64}$/.test(v) ? v : null
  } catch {
    return null
  }
}
function writeSession(key: string, value: string | null) {
  try {
    if (value) window.sessionStorage.setItem(key, value)
    else window.sessionStorage.removeItem(key)
  } catch {
    // Storage blocked: the panel starts a new conversation next time.
  }
}

/**
 * The Ask AI panel (design §8.6, PRODUCT §5): the assistant beside the page
 * the owner is working on. From lg a non-modal panel docked on the right
 * under the site header — no scrim, no focus trap, `role="complementary"` —
 * so the owner keeps typing in the editor; below lg a modal bottom sheet.
 * Loaded on first open (AskAiHost), it stays mounted while the page lives,
 * so its conversation (one per page, kept for this tab) survives closing it.
 *
 * The same engine as Admin → AI: the run is the server's (useRun), the
 * conversation is drawn by MessageList and ChatMarkdown, changes are the
 * server's cards. From an editor, every message carries the editor's state
 * (attachmentsOf), so a change to that document comes back as a suggestion
 * the owner applies there (EditorSuggestion) — nothing is written until
 * they save. Open full view continues the conversation in Admin → AI.
 */
export default function AskPanel({
  isOpen,
  onClose,
  chips,
  onChips,
  request,
  editor,
  doc,
  label,
  scope,
}: {
  isOpen: boolean
  onClose: () => void
  chips: AskChip[]
  onChips: (chips: AskChip[]) => void
  request: { prompt?: string; changeId?: string; n: number }
  editor: EditorHost | null
  doc: DocHost | null
  label?: string
  scope: string
}) {
  const mode = useBreakpointValue<'sheet' | 'panel'>({ base: 'sheet', lg: 'panel' }, { ssr: false }) ?? 'panel'
  const storeKey = `ai:ask:${scope}`
  const [summary, setSummary] = useState<AiSummaryView | null>(null)
  const [providers, setProviders] = useState<ProvidersAnswer | null>(null)
  const [loadError, setLoadError] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  /** The shown conversation's own provider and model (a conversation never changes model). */
  const [header, setHeader] = useState<ConversationDetail['conversation'] | null>(null)
  const [draft, setDraft] = useState('')
  const [epoch, setEpoch] = useState(0)
  const [announce, setAnnounce] = useState('')
  const [opened, setOpened] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [log, setLog] = useState<HTMLDivElement | null>(null)
  const follow = useRef(true)
  const inRun = useRef(false)
  const approvals = useRef(new Map<string, string>())
  const announced = useRef(new Set<string>())

  const toLogin = useCallback(() => {
    window.location.href = loginHref(`${window.location.pathname}${window.location.search}`)
  }, [])

  const loadBasics = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([getJson<AiSummaryView>('/api/admin/ai/summary'), getJson<ProvidersAnswer>('/api/admin/ai/providers')])
      setSummary(s)
      setProviders(p)
      setLoadError('')
    } catch (err) {
      if (err instanceof Unauthorized) return toLogin()
      setLoadError(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : NETWORK_ERROR)
    }
  }, [toLogin])

  const loadHeader = useCallback(async (id: string) => {
    try {
      const d = await getJson<ConversationDetail>(`/api/admin/ai/conversations/${encodeURIComponent(id)}`)
      setHeader(d.conversation)
    } catch {
      // The header keeps what it had; the conversation says the rest.
    }
  }, [])

  const run = useRun({
    onUnauthorized: toLogin,
    onStarted: (t: Transcript) => {
      if (!inRun.current) approvals.current = new Map()
      inRun.current = true
      setAnnounce(A.status.replying)
      if (t.conversationId) {
        setConversationId(t.conversationId)
        writeSession(storeKey, t.conversationId)
        if (header?.id !== t.conversationId) void loadHeader(t.conversationId)
      }
    },
    onEnded: (t: Transcript) => {
      const said = inRun.current ? Array.from(approvals.current.values()) : []
      for (const id of approvals.current.keys()) announced.current.add(id)
      inRun.current = false
      approvals.current = new Map()
      setAnnounce(endAnnouncement(t.end, said))
      // The cards read their state again (a Stop, AI access turned off, a decision elsewhere).
      setEpoch((n) => n + 1)
      if (t.end && t.end.state !== 'finished') void loadBasics()
    },
  })
  const { transcript } = run

  // Once, when the panel first opens: the switches and models, and this page's conversation (re-attached when a
  // run is still writing into it).
  useEffect(() => {
    void loadBasics()
    const stored = readSession(storeKey)
    if (stored) {
      setConversationId(stored)
      void run.open(stored).then((detail) => {
        if (detail) return setHeader(detail.conversation)
        writeSession(storeKey, null)
        setConversationId(null)
        run.reset()
      })
    }
    // On mount only: the scope is fixed for this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // An entry point asked for something: its prompt in the box (the owner sends or changes it), a change from Changes.
  const wantFocus = useRef(false)
  useEffect(() => {
    if (request.n === 0) return
    if (request.prompt) setDraft(request.prompt)
    if (request.changeId) setOpened(request.changeId)
    wantFocus.current = true
  }, [request.n, request.prompt, request.changeId])
  // The owner opened the panel: the message box takes the focus as soon as it is there (the panel never opens by
  // itself), once per opening.
  useEffect(() => {
    if (isOpen) wantFocus.current = true
  }, [isOpen])
  const boxReady = !!summary && !!providers
  useEffect(() => {
    if (!isOpen || !wantFocus.current || !boxReady) return
    const id = requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      wantFocus.current = false
      el.focus({ preventScroll: true })
      el.setSelectionRange(el.value.length, el.value.length)
    })
    return () => cancelAnimationFrame(id)
  }, [isOpen, boxReady, request.n, mode])

  // Following the bottom of the conversation inside the panel, while the owner is there.
  const growth = `${transcript.turns.length}:${transcript.live?.text.length ?? 0}:${transcript.live?.tools.length ?? 0}:${run.sending ?? ''}:${transcript.end ? 1 : 0}`
  useEffect(() => {
    if (!log || !follow.current) return
    requestAnimationFrame(() => log.scrollTo({ top: log.scrollHeight }))
  }, [growth, log])
  useEffect(() => {
    if (!log) return
    const onScroll = () => {
      follow.current = log.scrollHeight - log.scrollTop - log.clientHeight < 64
    }
    log.addEventListener('scroll', onScroll, { passive: true })
    return () => log.removeEventListener('scroll', onScroll)
  }, [log])

  const providerList = useMemo(() => providers?.providers ?? [], [providers])
  const access = summary?.access ?? null
  const accessOn = !!access && access.enabled && !access.blocked
  const provider = useMemo(() => defaultProvider(providerList, providers?.defaultProviderId ?? null), [providerList, providers])
  const running = transcript.live !== null
  const loading = !summary || !providers
  const noModels = !loading && providerList.length === 0

  let disabledReason: string | null = null
  if (!accessOn) disabledReason = A.composer.off
  else if (conversationId && header && !header.providerAvailable) disabledReason = A.composer.gone
  else if (!conversationId && !provider) disabledReason = A.composer.noModel
  else if (provider && !conversationId && (provider.keyState === 'reenter' || provider.keyState === 'no-secret')) disabledReason = A.empty.reenter(provider.label)

  const send = async () => {
    const text = draft.trim()
    if (!text || running || run.sending !== null || disabledReason || run.opening) return
    setDraft('')
    follow.current = true
    const ok = await run.send({ conversationId, message: text, providerId: conversationId ? null : (provider?.id ?? null), attachments: attachmentsOf(chips, editor) })
    if (!ok) setDraft(text)
    // A selection goes with one message.
    else if (chips.some((c) => c.kind === 'selection')) onChips(chips.filter((c) => c.kind !== 'selection'))
  }

  const newChat = () => {
    run.reset()
    setConversationId(null)
    setHeader(null)
    writeSession(storeKey, null)
    setAnnounce('')
    announced.current = new Set()
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const act = (a: EndAction) => {
    if (a === 'retry' || a === 'continue') {
      if (conversationId && !running && run.sending === null && !run.opening) void run.send({ conversationId, continue: true, attachments: attachmentsOf(chips, editor, false) })
      return
    }
    if (a === 'new-chat') return newChat()
    window.location.href = '/admin/ai?view=models'
  }
  const actionLabel = (a: EndAction) =>
    a === 'retry' ? A.actions.retry : a === 'continue' ? A.actions.continue : a === 'new-chat' ? A.actions.newChat : a === 'replace-key' ? A.actions.replaceKey : a === 'change-limit' ? A.actions.changeLimit : A.actions.models

  const onChangeState = useCallback((id: string, state: ChangeState, title: string) => {
    if (state !== 'waiting') approvals.current.delete(id)
    if (state === 'waiting' && !announced.current.has(id)) {
      if (inRun.current) {
        approvals.current.set(id, title)
        return
      }
      announced.current.add(id)
      setAnnounce(A.status.approval(title))
    }
  }, [])
  const refs = useRef(new Map<string, (el: HTMLDivElement | null) => void>())
  const changeRef = useCallback((id: string) => {
    let fn = refs.current.get(id)
    if (!fn) {
      fn = () => {}
      refs.current.set(id, fn)
    }
    return fn
  }, [])
  const putInComposer = useCallback((text: string) => {
    setDraft(text)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [])

  const what = label ?? (editor ? `this ${editor.target.kind === 'page' ? 'page' : editor.target.collection === 'blog' ? 'post' : 'case study'}` : null)
  const intro = editor && editor.version ? K.intro(what ?? 'this page') : doc ? K.introServer(what ?? 'this page') : K.introPlain
  const usage = usageLine(transcript.usage)
  const problem = run.problem
  const status = modelStatusOf(provider)
  const fullHref = conversationId ? `/admin/ai?c=${encodeURIComponent(conversationId)}` : '/admin/ai'

  // A conversation keeps the model it began with; a new one starts on the default model.
  const conversationProvider = header ? (providerList.find((p) => p.id === header.providerId) ?? null) : null
  const modelControl =
    conversationId && header ? (
      <PinnedModel label={`${A.header.meta(header.providerLabel, header.model)}${header.chatOnly ? ` · ${A.header.chatOnly}` : ''}`} />
    ) : provider && !conversationId ? (
      <PinnedModel label={`${A.composer.modelOption(provider.label, provider.defaultModel ?? A.composer.noModelSet)}${status !== 'ready' ? A.composer.statusMark(statusLabel(status)) : ''}`} />
    ) : null
  const privacyName = conversationId ? (header?.providerLabel ?? null) : (provider?.label ?? null)
  const privacyHost = conversationId ? (conversationProvider?.baseUrlHost ?? '') : (provider?.baseUrlHost ?? '')
  const view = endView(transcript.end, privacyName ?? '')

  const problemNotice = problem ? (
    <Alert status={problem.code === 'RUN_ACTIVE' ? 'info' : 'warning'} variant="left-accent" borderRadius="md" bg="page.bg-elevated" mb={3} fontSize="sm" alignItems="center" flexWrap="wrap" gap={2} role="alert">
      <AlertIcon />
      <AlertDescription flex="1 1 200px">
        <Text as="span" fontWeight={600}>
          {A.composer.notSent}.{' '}
        </Text>
        {problem.error}
      </AlertDescription>
      {problem.code === 'RUN_ACTIVE' && problem.conversationId ? (
        <Button as={NextLink} href={`/admin/ai?c=${encodeURIComponent(problem.conversationId)}`} size="xs" {...outlineButtonProps} minH={{ base: '44px', md: '24px' }}>
          {A.composer.openRunning}
        </Button>
      ) : null}
    </Alert>
  ) : null

  const body: ReactNode = loadError && !summary ? (
    <Alert status="error" variant="left-accent" borderRadius="md" bg="page.bg-elevated" alignItems="center" flexWrap="wrap" gap={2}>
      <AlertIcon />
      <AlertDescription fontSize="sm" flex="1 1 200px">
        {K.loadError(loadError)}
      </AlertDescription>
      <Button size="sm" {...outlineButtonProps} onClick={() => void loadBasics()} minH={{ base: '44px', md: '32px' }}>
        {K.retry}
      </Button>
    </Alert>
  ) : loading ? (
    <Box aria-busy="true" aria-label={K.loading}>
      <Skeleton h="16px" w="80%" />
      <Skeleton h="16px" w="60%" mt={3} />
    </Box>
  ) : (
    <>
      {opened ? (
        <Box mb={5}>
          <ChatChange id={opened} epoch={epoch} onState={onChangeState} onUnauthorized={toLogin} />
        </Box>
      ) : null}
      {!conversationId && !accessOn ? (
        <PanelEmpty title={K.off} body={K.offBody} action={<Button as={NextLink} href="/admin/ai?view=connections" size="sm" {...primaryButtonProps} minH={{ base: '44px', md: '32px' }}>{K.openConnections}</Button>} />
      ) : !conversationId && noModels ? (
        <PanelEmpty title={K.noModel} body={K.noModelBody} action={<Button as={NextLink} href="/admin/ai?view=models" size="sm" {...primaryButtonProps} minH={{ base: '44px', md: '32px' }}>{K.openModels}</Button>} />
      ) : !conversationId && !run.sending ? (
        <Text fontSize="sm" color="page.fg-secondary" data-ask-intro="">
          {intro}
        </Text>
      ) : null}
      {conversationId && run.loadError && run.loadError !== 'not-found' ? (
        <Text fontSize="sm" color="status.error">
          {run.loadError}
        </Text>
      ) : null}
      {(conversationId && !run.loadError) || run.sending ? (
        <MessageList
          transcript={transcript}
          sending={run.sending}
          endNotice={conversationId ? view : null}
          onAction={act}
          actionLabel={actionLabel}
          usage={usage}
          onChangeState={onChangeState}
          onAskAgain={putInComposer}
          onUnauthorized={toLogin}
          changeRef={changeRef}
          epoch={epoch}
        />
      ) : null}
    </>
  )

  const editorDirty = !!editor?.dirty
  // "@" typed at the start of the message or after a space opens + Context (PRODUCT §4.6); the "@" is not kept.
  const changeDraft = (value: string) => {
    if (value.length === draft.length + 1 && value.endsWith('@') && value.slice(0, -1) === draft && (draft === '' || /\s$/.test(draft))) {
      setPicking(true)
      return
    }
    setDraft(value)
  }
  const addChip = (chip: AskChip) => onChips([...chips, chip])
  const backToBox = () => requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
  const composer =
    !loading && (accessOn || conversationId) && !(noModels && !conversationId) ? (
      <Composer
        inPanel
        id="ask-composer"
        value={draft}
        onChange={changeDraft}
        onSend={() => void send()}
        onStop={() => void run.stop()}
        onRecall={() => {
          const last = lastUserText(transcript.turns)
          if (last) setDraft(last)
        }}
        running={running}
        sending={run.sending !== null && !running}
        stopping={run.stopping}
        disabled={!!disabledReason || run.opening}
        disabledReason={disabledReason}
        model={modelControl}
        notice={problemNotice}
        textareaRef={textareaRef}
        chips={<ContextChips chips={chips} dirty={editorDirty} onRemove={(c) => {
          // The chip and its × go: the focus goes back to the message box.
          onChips(chips.filter((x) => x !== c))
          backToBox()
        }} add={<ContextPicker chips={chips} onAdd={addChip} isOpen={picking} onOpenChange={setPicking} onDone={backToBox} />} />}
      />
    ) : null

  const content = (
    <PanelHostContext.Provider value={{ editor, doc }}>
      <Flex direction="column" h="100%" minH={0}>
        <Box borderBottom="1px solid" borderColor="page.border" flexShrink={0} pb={2.5}>
          <Flex align="center" gap={2} px={4} pt={3}>
            <Box minW={0} flex="1">
              <Text fontFamily={MONO} fontSize="10px" letterSpacing="0.16em" textTransform="uppercase" color="accent.text">
                {K.eyebrow}
              </Text>
              <Heading as="h2" id="ask-panel-title" fontSize="md" fontWeight={600} letterSpacing="-0.01em" mt={0.5} noOfLines={1}>
                {K.panel}
              </Heading>
            </Box>
            <Button size="sm" variant="ghost" color="page.fg-secondary" leftIcon={<FiPlus aria-hidden />} onClick={newChat} isDisabled={!conversationId && !run.sending} minH={{ base: '44px', md: '32px' }}>
              {K.newChat}
            </Button>
            <IconButton
              as={NextLink}
              href={fullHref}
              aria-label={K.fullView}
              title={K.fullViewHint}
              icon={<FiExternalLink aria-hidden />}
              size="sm"
              variant="ghost"
              color="page.fg-secondary"
              minW={{ base: '44px', md: '32px' }}
              h={{ base: '44px', md: '32px' }}
            />
            <IconButton aria-label={K.close} icon={<FiX aria-hidden />} size="sm" variant="ghost" color="page.fg-secondary" onClick={onClose} minW={{ base: '44px', md: '32px' }} h={{ base: '44px', md: '32px' }} data-testid="ask-close" />
          </Flex>
          {privacyName && accessOn ? (
            <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" px={4} pt={1.5} data-privacy-line="">
              {K.privacy(privacyName, privacyHost)}
            </Text>
          ) : null}
        </Box>
        <Box ref={setLog} flex="1" minH={0} overflowY="auto" px={4} py={4} sx={{ overscrollBehavior: 'contain' }} data-ask-log="">
          {body}
        </Box>
        <Box px={4} flexShrink={0} borderTop={composer ? '1px solid' : undefined} borderColor="page.border">
          {composer}
        </Box>
        <VisuallyHidden role="status" aria-live="polite" aria-atomic="true" data-testid="ask-status">
          {announce}
        </VisuallyHidden>
      </Flex>
    </PanelHostContext.Provider>
  )

  // Esc closes the panel unless something inside handled it (the message box stops an answer with it).
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || running || picking) return
    e.preventDefault()
    onClose()
  }

  if (mode === 'sheet') {
    return (
      <Drawer isOpen={isOpen} onClose={onClose} placement="bottom" initialFocusRef={textareaRef} returnFocusOnClose={false}>
        <DrawerOverlay />
        <DrawerContent bg="page.bg" borderTop="1px solid" borderColor="page.border" borderTopRadius="xl" h="92dvh" maxH="92dvh" aria-labelledby="ask-panel-title" onKeyDown={onKeyDown} data-ask-panel="sheet">
          <DrawerBody p={0} display="flex" flexDirection="column" minH={0}>
            {content}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <>
      {isOpen ? (
        // Docked: the page's content and footer make room for the panel (the site header keeps its full width above
        // it), and the floating toasts and back-to-top move out from under it.
        <Global
          styles={{
            '@media (min-width: 62em)': {
              '#main, #main + div': { paddingRight: `${ASK_PANEL_W}px` },
              '#chakra-toast-manager-bottom-right, #chakra-toast-manager-top-right': { right: `calc(${ASK_PANEL_W}px + env(safe-area-inset-right, 0px)) !important` },
              '.scroll-top': { right: `calc(${ASK_PANEL_W + 16}px + env(safe-area-inset-right, 0px)) !important` },
            },
          }}
        />
      ) : null}
      <Box
        as="aside"
        role="complementary"
        aria-label={K.panel}
        position="fixed"
        top={SITE_HEADER_H}
        right={0}
        bottom={0}
        w={`${ASK_PANEL_W}px`}
        maxW="100vw"
        zIndex={30}
        bg="page.bg"
        borderLeft="1px solid"
        borderColor="page.border"
        boxShadow="-12px 0 32px rgba(0,0,0,0.06)"
        display={isOpen ? 'block' : 'none'}
        onKeyDown={onKeyDown}
        sx={{
          '@keyframes askIn': { from: { opacity: 0, transform: 'translateX(12px)' }, to: { opacity: 1, transform: 'none' } },
          animation: 'askIn 160ms cubic-bezier(0.22, 1, 0.36, 1)',
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }}
        className="no-print"
        data-ask-panel="panel"
      >
        {content}
      </Box>
    </>
  )
}

function PanelEmpty({ title, body, action }: { title: string; body: string; action: ReactNode }) {
  return (
    <Box border="1px solid" borderColor="page.border" borderRadius="xl" p={4} data-empty-state="">
      <Text fontSize="sm" fontWeight={600}>
        {title}
      </Text>
      <Text fontSize="sm" color="page.fg-secondary" mt={1}>
        {body}
      </Text>
      <Flex mt={3}>{action}</Flex>
    </Box>
  )
}
