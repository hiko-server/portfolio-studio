import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { useRouter } from 'next/router'
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertIcon,
  Box,
  Button,
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerHeader,
  DrawerOverlay,
  Flex,
  Grid,
  Heading,
  Select,
  Skeleton,
  Text,
  VisuallyHidden,
  useToast,
} from '@chakra-ui/react'
import { FiClock, FiPlus } from 'react-icons/fi'
import { MONO, SITE_HEADER_H, inputProps, outlineButtonProps, primaryButtonProps } from '../shell/ui'
import { loginHref, readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { readDraft, removeDraft, writeDraft } from '../shell/useLocalDraft'
import { ASSISTANT_COPY } from './copy'
import Composer, { PinnedModel } from './Composer'
import ContextChips from './ContextChips'
import ContextPicker from './ContextPicker'
import { attachmentsOf } from './askAttachments'
import type { AskChip } from './askContext'
import ConversationRail from './ConversationRail'
import MessageList from './MessageList'
import { useRun } from './useRun'
import { unfollowedRun, useRunWatch } from './useRunWatch'
import { lastUserText, type Transcript } from './runState'
import {
  defaultProvider,
  endAnnouncement,
  endView,
  messageLang,
  modelStatusOf,
  promptLang,
  statusLabel,
  suggestedPrompts,
  usageLine,
  type EndAction,
  type SiteFacts,
} from './assistantFormat'
import type { AiSummaryView, ChangeState, ConversationDetail, ConversationListItem, ProviderView, ProvidersAnswer, RunView } from './types'

const A = ASSISTANT_COPY
const PAGE = 100
/** Under the site header and the title bar (its tabs fit one row from lg). */
const RAIL_TOP = `calc(${SITE_HEADER_H} + 72px)`

class Unauthorized extends Error {}

async function getJson<T = Record<string, any>>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
  if (res.status === 401) throw new Unauthorized()
  const json = await readJsonObject(res)
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
  return json as T
}

const draftKey = (conversationId: string | null) => `ai:chat:${conversationId ?? 'new'}`

/**
 * Admin → AI → Assistant, the default view (design §8.1, §8.3, §8.4; PRODUCT
 * §4): the conversation rail (History below lg), the conversation in the
 * page's own flow, and the message box at the bottom of the screen.
 *
 * Everything here is real: the conversations are the server's, a run is
 * followed over its event stream (useRun) and re-attached after a reload, a
 * reply is drawn by ChatMarkdown only, every change the assistant makes or
 * proposes is the same card as in Changes. Empty states say only what is
 * true; suggestions come from the site's own counts. Nothing takes the
 * focus by itself: one polite status line says what happened.
 */
export default function AssistantPanel({
  onShowModels,
  onShowConnections,
  onAddModel,
  onChangesMoved,
}: {
  onShowModels: () => void
  onShowConnections: () => void
  /** Models, with Add a model open. */
  onAddModel: () => void
  /** A change was decided here (the Changes tab's count follows). */
  onChangesMoved?: () => void
}) {
  const router = useRouter()
  const toast = useToast()
  const param = router.isReady && typeof router.query.c === 'string' ? router.query.c : null

  const [summary, setSummary] = useState<AiSummaryView | null>(null)
  const [providers, setProviders] = useState<ProvidersAnswer | null>(null)
  const [loadError, setLoadError] = useState('')
  const [list, setList] = useState<ConversationListItem[]>([])
  const [listState, setListState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [hasMore, setHasMore] = useState(false)
  const [header, setHeader] = useState<ConversationDetail['conversation'] | null>(null)
  const [writing, setWriting] = useState<RunView | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** Chips attached to the next message with + Context (PRODUCT §4.6): typed references, sent once. */
  const [chips, setChips] = useState<AskChip[]>([])
  const [picking, setPicking] = useState(false)
  const [facts, setFacts] = useState<SiteFacts | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [deleting, setDeleting] = useState<ConversationListItem | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [changeStates, setChangeStates] = useState<Record<string, { state: ChangeState; title: string }>>({})
  const [announce, setAnnounce] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const announcedWaiting = useRef(new Set<string>())
  /** A run is being followed here: a change that comes to wait during it is said after the run's end, not before. */
  const inRun = useRef(false)
  const approvalsInRun = useRef(new Map<string, string>())
  const cardRefs = useRef(new Map<string, HTMLDivElement | null>())
  const refFns = useRef(new Map<string, (el: HTMLDivElement | null) => void>())
  const shownId = useRef<string | null>(null)
  const followBottom = useRef(true)
  /** The latest list request: only its answer says what is being written (an older one predates a start or an end since). */
  const listSeq = useRef(0)
  const writingRef = useRef(writing)
  writingRef.current = writing

  const toLogin = useCallback(() => {
    window.location.href = loginHref(`${window.location.pathname}${window.location.search}`)
  }, [])

  // ── Loading ──────────────────────────────────────────────────────────

  const loadList = useCallback(
    async (more = false) => {
      const mine = ++listSeq.current
      try {
        const before = more && list.length ? `?before=${list[list.length - 1].updatedAt}` : ''
        const json = await getJson<{ conversations: ConversationListItem[]; active: RunView | null }>(`/api/admin/ai/conversations${before}`)
        const page = Array.isArray(json.conversations) ? json.conversations : []
        setList((prev) => (more ? [...prev, ...page.filter((c) => !prev.some((p) => p.id === c.id))] : page))
        setHasMore(page.length >= PAGE)
        if (mine === listSeq.current) setWriting(json.active && json.active.live ? json.active : null)
        setListState('ok')
      } catch (err) {
        if (err instanceof Unauthorized) return toLogin()
        setListState('error')
      }
    },
    [list, toLogin],
  )
  const loadListRef = useRef(loadList)
  loadListRef.current = loadList

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
      if (shownId.current === id) setHeader(d.conversation)
    } catch {
      // The header keeps what it had; the transcript says the rest.
    }
  }, [])

  const run = useRun({
    onUnauthorized: toLogin,
    onStarted: (t: Transcript) => {
      // A run whose end this view never handled (the next message went while that end was still being read): what
      // came to wait in it is said at this run's end with the rest, not dropped.
      if (!inRun.current) approvalsInRun.current = new Map()
      inRun.current = true
      setAnnounce(A.status.replying)
      if (t.runId && t.conversationId) setWriting({ id: t.runId, conversationId: t.conversationId, state: 'running', reason: null, startedAt: Date.now(), finishedAt: null, live: true, lastSeq: t.lastSeq })
      if (t.conversationId && shownId.current !== t.conversationId) {
        // A new conversation: it has an address now (a reload comes back to it).
        shownId.current = t.conversationId
        void router.replace({ pathname: router.pathname, query: { ...router.query, c: t.conversationId } }, undefined, { shallow: true, scroll: false })
        void loadHeader(t.conversationId)
      }
      void loadList()
    },
    onEnded: (t: Transcript) => {
      setWriting(null)
      const e = t.end
      // How it ended, then what came to wait for the owner during it (never the end over a waiting change).
      const approvals = inRun.current ? Array.from(approvalsInRun.current.values()) : []
      for (const id of approvalsInRun.current.keys()) announcedWaiting.current.add(id)
      inRun.current = false
      approvalsInRun.current = new Map()
      setAnnounce(endAnnouncement(e, approvals))
      if (t.conversationId) void loadHeader(t.conversationId)
      void loadList()
      // The cards read their state again (waiting changes are voided when AI access goes off).
      setEpoch((n) => n + 1)
      // AI access off, the session or a provider failing: the switches and the models may have changed.
      if (e && e.state !== 'finished') void loadBasics()
    },
  })
  const { transcript } = run

  useEffect(() => {
    void loadBasics()
    void loadList()
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // An answer this page does not follow (another conversation's, or one the owner left while it was written): the
  // page asks the server whether it is still written, and when it ends, the notice, the rail's dot and the disabled
  // Send go with it; the list reads how it ended.
  useRunWatch(unfollowedRun(writing, transcript), {
    onOver: (id, active) => {
      setWriting((prev) => (prev?.id === id ? active : prev))
      void loadListRef.current()
    },
    onUnauthorized: toLogin,
  })
  // The run this view followed has ended (its end is drawn): it is no longer being written, even when the owner
  // leaves before that end's re-read comes back (useRun then reports nothing of it).
  useEffect(() => {
    if (transcript.end && transcript.runId && writing?.id === transcript.runId) setWriting(null)
  }, [transcript.end, transcript.runId, writing])

  /**
   * A conversation's own answer says whether a run is writing into it. None, while the page thought one was: that
   * answer has ended, and the list (whose answer is the newest word on what is written) says so at once.
   */
  const settleWriting = useCallback((detail: ConversationDetail) => {
    if (!detail.active?.live && writingRef.current?.conversationId === detail.conversation.id) void loadListRef.current()
  }, [])

  /** Another conversation (or a new chat) is shown: what was said, waiting and scrolled belongs to the one before. */
  const leaveConversation = useCallback(() => {
    setHeader(null)
    setChangeStates({})
    // The status line spoke of the conversation left; an emptied live region says nothing.
    setAnnounce('')
    announcedWaiting.current = new Set()
    inRun.current = false
    approvalsInRun.current = new Map()
    followBottom.current = true
    setAtBottom(true)
    setUnseen(false)
  }, [])

  // The conversation in the address: open it (re-attaching to a run writing into it). None: a new chat, unless a
  // run is being written right now — then that conversation (a reload of /admin/ai finds its answer again).
  useEffect(() => {
    if (!router.isReady) return
    let cancelled = false
    void (async () => {
      if (param) {
        if (param === shownId.current) return
        shownId.current = param
        leaveConversation()
        const detail = await run.open(param)
        // Only the address decides (an effect run twice, as React's strict mode does, must still show the header).
        if (shownId.current !== param) return
        setHeader(detail?.conversation ?? null)
        if (detail) settleWriting(detail)
        return
      }
      if (shownId.current === null && transcript.conversationId === null && !transcript.live) {
        // First visit without a conversation: is something being written?
        try {
          const active = await getJson<{ active: RunView | null }>('/api/admin/ai/runs')
          if (!cancelled && active.active?.live && shownId.current === null) {
            void router.replace({ pathname: router.pathname, query: { ...router.query, c: active.active.conversationId } }, undefined, { shallow: true, scroll: false })
            return
          }
        } catch (err) {
          if (err instanceof Unauthorized) return toLogin()
        }
      }
      if (shownId.current !== null || transcript.conversationId !== null) {
        shownId.current = null
        leaveConversation()
        run.reset()
      }
    })()
    return () => {
      cancelled = true
    }
    // The address decides; the run's own state is read through refs inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, param])

  // ── The message box's draft: kept per conversation on this device ──────

  const key = draftKey(param)
  useEffect(() => {
    setDraft(readDraft<string>(key)?.value ?? '')
  }, [key])
  const changeDraft = useCallback(
    (value: string) => {
      setDraft(value)
      if (value) writeDraft(key, { at: Date.now(), etag: null, value })
      else removeDraft(key)
    },
    [key],
  )

  // ── Suggestions (a new chat only), from the site's own counts ─────────

  const isNew = !param && !transcript.conversationId
  useEffect(() => {
    if (!isNew || facts) return
    let cancelled = false
    void Promise.allSettled([getJson('/api/admin/overview'), getJson('/api/admin/content-health?summary=1')]).then(([o, h]) => {
      if (cancelled) return
      const ov = o.status === 'fulfilled' ? o.value : null
      const hc = h.status === 'fulfilled' ? (h.value as { counts?: { error?: number; warning?: number } }).counts : null
      setFacts({
        drafts: typeof ov?.posts?.drafts === 'number' ? ov.posts.drafts : null,
        published: typeof ov?.posts?.published === 'number' ? ov.posts.published : null,
        aboutEmpty: typeof ov?.pages?.aboutEmpty === 'boolean' ? ov.pages.aboutEmpty : null,
        missingAlt: typeof ov?.media?.missingAlt === 'number' ? ov.media.missingAlt : null,
        healthIssues: hc && typeof hc.error === 'number' && typeof hc.warning === 'number' ? hc.error + hc.warning : null,
      })
    })
    return () => {
      cancelled = true
    }
  }, [isNew, facts])

  // ── Following the bottom of the conversation ──────────────────────────

  const composerHeight = () => (document.querySelector('[data-composer]') as HTMLElement | null)?.offsetHeight ?? 0
  const measure = useCallback(() => {
    const el = sentinel.current
    if (!el) return true
    return el.getBoundingClientRect().top <= window.innerHeight - composerHeight() + 48
  }, [])
  const toBottom = useCallback(() => {
    const el = sentinel.current
    if (!el) return
    const top = el.getBoundingClientRect().top + window.scrollY - (window.innerHeight - composerHeight()) + 24
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
    followBottom.current = true
    setAtBottom(true)
    setUnseen(false)
  }, [])
  useEffect(() => {
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const bottom = measure()
        followBottom.current = bottom
        setAtBottom(bottom)
        if (bottom) setUnseen(false)
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [measure])
  const growth = `${transcript.turns.length}:${transcript.live?.text.length ?? 0}:${transcript.live?.tools.length ?? 0}:${transcript.live?.thinking.join('').length ?? 0}:${run.sending ?? ''}:${transcript.end ? 1 : 0}`
  useEffect(() => {
    if (followBottom.current) requestAnimationFrame(() => toBottom())
    else setUnseen(true)
  }, [growth, toBottom])
  // What settles after the scroll (a change card loads after its turn is drawn, a table or a reply's last paint):
  // while the owner follows the bottom, the bottom stays in view; scrolled up, nothing moves.
  const [logEl, setLogEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!logEl || typeof ResizeObserver === 'undefined') return
    let frame = 0
    let height = logEl.offsetHeight
    const ro = new ResizeObserver(() => {
      const next = logEl.offsetHeight
      if (next === height) return
      height = next
      if (!followBottom.current) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => toBottom())
    })
    ro.observe(logEl)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [logEl, toBottom])

  // ── What the owner can do now ─────────────────────────────────────────

  const providerList = useMemo(() => providers?.providers ?? [], [providers])
  const access = summary?.access ?? null
  const accessOn = !!access && access.enabled && !access.blocked
  const newChatProvider: ProviderView | null = useMemo(() => providerList.find((p) => p.id === chosen) ?? defaultProvider(providerList, providers?.defaultProviderId ?? null), [providerList, chosen, providers])
  // The address decides which conversation this is (the transcript follows it: useRun drops a superseded load);
  // before a new conversation has its address, the run's own id.
  const conversationId = param ?? transcript.conversationId
  const conversationProvider = header ? providerList.find((p) => p.id === header.providerId) ?? null : null
  const running = transcript.live !== null
  const busyElsewhere = !!writing && writing.live && writing.conversationId !== conversationId
  const provider = conversationId ? conversationProvider : newChatProvider
  const providerName = conversationId ? (header?.providerLabel ?? conversationProvider?.label ?? '') : (newChatProvider?.label ?? '')
  const providerHost = provider?.baseUrlHost ?? ''

  let disabledReason: string | null = null
  if (!accessOn) disabledReason = A.composer.off
  else if (conversationId && header && !header.providerAvailable) disabledReason = A.composer.gone
  else if (!conversationId && !newChatProvider) disabledReason = A.composer.noModel
  else if (busyElsewhere) disabledReason = A.composer.busyElsewhere
  else if (provider && (provider.keyState === 'reenter' || provider.keyState === 'no-secret')) disabledReason = A.empty.reenter(provider.label)

  /** What is shown is one conversation: its address, header and messages (never one's messages under another's address). */
  const coherent = !param || transcript.conversationId === param
  const send = async () => {
    const text = draft.trim()
    if (!text || running || run.sending !== null || disabledReason || run.opening || !coherent) return
    changeDraft('')
    followBottom.current = true
    const ok = await run.send({ conversationId, message: text, providerId: conversationId ? null : (newChatProvider?.id ?? null), attachments: attachmentsOf(chips, null) })
    if (!ok) changeDraft(text)
    else setChips([])
  }

  const act = (a: EndAction) => {
    if (a === 'retry' || a === 'continue') {
      if (conversationId && !running && run.sending === null && !run.opening && coherent) void run.send({ conversationId, continue: true })
      return
    }
    if (a === 'new-chat') return newChat()
    onShowModels()
  }
  const actionLabel = (a: EndAction) =>
    a === 'retry' ? A.actions.retry : a === 'continue' ? A.actions.continue : a === 'new-chat' ? A.actions.newChat : a === 'replace-key' ? A.actions.replaceKey : a === 'change-limit' ? A.actions.changeLimit : A.actions.models

  const newChat = useCallback(() => {
    setHistoryOpen(false)
    const query = { ...router.query }
    delete query.c
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true, scroll: false })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [router])

  /** Load the shown conversation again (Retry after a failed load; a run writing into it is attached). */
  const reopen = useCallback(
    async (id: string) => {
      const detail = await run.open(id)
      if (detail && shownId.current === id) {
        setHeader(detail.conversation)
        settleWriting(detail)
      }
    },
    [run, settleWriting],
  )
  /** "Open it": the conversation being answered. Already shown here: follow its run now (the address is the same). */
  const openRunning = (id: string) => {
    if (id === conversationId) {
      run.clearProblem()
      void reopen(id)
      return
    }
    void router.replace({ pathname: router.pathname, query: { ...router.query, c: id } }, undefined, { shallow: true, scroll: false })
  }

  const putInComposer = useCallback(
    (text: string) => {
      changeDraft(text)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      })
    },
    [changeDraft],
  )

  const onChangeState = useCallback(
    (id: string, state: ChangeState, title: string) => {
      setChangeStates((prev) => {
        const was = prev[id]?.state
        // A decision here, or a new proposal waiting: the Changes tab's count follows.
        if ((was && was !== state) || (!was && state === 'waiting')) onChangesMoved?.()
        return { ...prev, [id]: { state, title } }
      })
      // Decided before the run's end (approved from its card while the answer went on): no longer said as waiting.
      if (state !== 'waiting') approvalsInRun.current.delete(id)
      if (state === 'waiting' && !announcedWaiting.current.has(id)) {
        if (inRun.current) {
          // Said after the run's end (PRODUCT §4.8: replying, finished, then approval needed).
          approvalsInRun.current.set(id, title)
          return
        }
        announcedWaiting.current.add(id)
        setAnnounce(A.status.approval(title))
      }
    },
    [onChangesMoved],
  )
  const changeRef = useCallback((id: string): Ref<HTMLDivElement> => {
    let fn = refFns.current.get(id)
    if (!fn) {
      fn = (el: HTMLDivElement | null) => {
        cardRefs.current.set(id, el)
      }
      refFns.current.set(id, fn)
    }
    return fn
  }, [])
  const waitingIds = Object.entries(changeStates)
    .filter(([, v]) => v.state === 'waiting')
    .map(([id]) => id)
  const reviewFirst = () => {
    const el = waitingIds.map((id) => cardRefs.current.get(id)).find(Boolean)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.focus({ preventScroll: true })
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      const res = await fetch(`/api/admin/ai/conversations/${encodeURIComponent(deleting.id)}`, { method: 'DELETE', credentials: 'same-origin' })
      const json = await readJsonObject(res)
      if (res.status === 401) return toLogin()
      if (!res.ok) {
        toast({ status: 'error', title: A.rail.notDeleted, description: typeof json.error === 'string' ? json.error : `HTTP ${res.status}`, duration: 6000, isClosable: true })
        return
      }
      toast({ status: 'success', title: A.rail.deleted, description: deleting.title })
      removeDraft(draftKey(deleting.id))
      if (deleting.id === conversationId) newChat()
      setList((prev) => prev.filter((c) => c.id !== deleting.id))
      void loadList()
    } catch {
      toast({ status: 'error', title: A.rail.notDeleted, description: NETWORK_ERROR, duration: 6000, isClosable: true })
    } finally {
      setDeleteBusy(false)
      setDeleting(null)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  if (loadError && !summary) {
    return (
      <Alert status="error" variant="left-accent" borderRadius="md" bg="page.bg-elevated">
        <AlertIcon />
        <AlertDescription fontSize="sm" flex={1}>
          {A.loadError(loadError)}
        </AlertDescription>
        <Button size="sm" {...outlineButtonProps} onClick={() => void loadBasics()}>
          {A.retry}
        </Button>
      </Alert>
    )
  }

  const rail = (
    <ConversationRail
      items={list}
      activeId={conversationId}
      writingId={writing?.live ? writing.conversationId : null}
      now={now}
      loading={listState === 'loading'}
      error={listState === 'error'}
      hasMore={hasMore}
      onMore={() => void loadList(true)}
      onNew={newChat}
      onPick={() => setHistoryOpen(false)}
      onDelete={setDeleting}
    />
  )

  const loading = !summary || !providers
  /** The address names a conversation the server doesn't have: say so and offer a new chat, never a message box. */
  const notFound = !!conversationId && run.loadError === 'not-found'
  const noModels = !loading && providerList.length === 0
  const status = modelStatusOf(newChatProvider)
  const view = endView(transcript.end, providerName)
  const usage = usageLine(transcript.usage)
  const problem = run.problem

  const modelControl = conversationId ? (
    header ? (
      <PinnedModel label={`${A.header.meta(header.providerLabel, header.model)}${header.chatOnly ? ` · ${A.header.chatOnly}` : ''}`} />
    ) : null
  ) : providerList.length > 1 ? (
    <Select
      size="sm"
      variant="unstyled"
      fontFamily={MONO}
      fontSize="11px"
      color="page.fg-secondary"
      w="auto"
      maxW="100%"
      value={newChatProvider?.id ?? ''}
      onChange={(e) => setChosen(e.target.value)}
      aria-label={A.composer.model}
      {...inputProps}
      sx={{ paddingInlineEnd: '1.5rem', minHeight: '28px' }}
    >
      {providerList.map((p) => (
        <option key={p.id} value={p.id}>
          {A.composer.modelOption(p.label, p.defaultModel ?? A.composer.noModelSet)}
          {modelStatusOf(p) !== 'ready' ? A.composer.statusMark(statusLabel(modelStatusOf(p))) : ''}
        </option>
      ))}
    </Select>
  ) : newChatProvider ? (
    <PinnedModel label={`${A.composer.modelOption(newChatProvider.label, newChatProvider.defaultModel ?? A.composer.noModelSet)}${status !== 'ready' ? A.composer.statusMark(statusLabel(status)) : ''}`} />
  ) : null

  const problemNotice = problem ? (
    <Alert status={problem.code === 'RUN_ACTIVE' ? 'info' : 'warning'} variant="left-accent" borderRadius="md" bg="page.bg-elevated" mb={3} fontSize="sm" alignItems="center" flexWrap="wrap" gap={2} role="alert">
      <AlertIcon />
      <AlertDescription flex="1 1 220px">
        <Text as="span" fontWeight={600}>
          {A.composer.notSent}.{' '}
        </Text>
        {problem.error}
      </AlertDescription>
      {problem.code === 'RUN_ACTIVE' && problem.conversationId ? (
        <Button size="xs" {...outlineButtonProps} onClick={() => problem.conversationId && openRunning(problem.conversationId)} minH={{ base: '44px', md: '24px' }}>
          {A.composer.openRunning}
        </Button>
      ) : problem.code === 'NO_PROVIDER' || problem.code === 'KEY_REENTER' || problem.code === 'NO_MODEL' || problem.code === 'NO_SECRET' ? (
        <Button size="xs" {...outlineButtonProps} onClick={onShowModels} minH={{ base: '44px', md: '24px' }}>
          {A.actions.models}
        </Button>
      ) : problem.code === 'PROVIDER_GONE' || problem.code === 'PROVIDER_CHANGED' ? (
        <Button size="xs" {...outlineButtonProps} onClick={newChat} minH={{ base: '44px', md: '24px' }}>
          {A.actions.newChat}
        </Button>
      ) : null}
    </Alert>
  ) : busyElsewhere && writing ? (
    <Flex align="center" gap={3} mb={3} fontSize="sm" color="page.fg-secondary" flexWrap="wrap">
      <Text flex="1 1 220px">{A.composer.busyElsewhere}</Text>
      <Button size="xs" {...outlineButtonProps} onClick={() => openRunning(writing.conversationId)} minH={{ base: '44px', md: '24px' }}>
        {A.composer.openRunning}
      </Button>
    </Flex>
  ) : null

  // The status row above the message box (PRODUCT §4.7): never a focus theft; Review moves the focus on request.
  const statusRow =
    waitingIds.length || (!atBottom && unseen) ? (
      <Flex justify="space-between" align="center" gap={2} mb={2} flexWrap="wrap">
        {waitingIds.length ? (
          <Button size="xs" variant="link" color="accent.text" fontWeight={500} onClick={reviewFirst} minH={{ base: '44px', md: '24px' }} data-testid="waiting-review">
            {A.log.waiting(waitingIds.length)} · {A.log.review}
          </Button>
        ) : (
          <Box />
        )}
        {!atBottom && unseen ? (
          <Button size="xs" {...outlineButtonProps} bg="page.bg" onClick={toBottom} minH={{ base: '44px', md: '24px' }} ml="auto">
            ↓ {A.log.jumpLatest}
          </Button>
        ) : null}
      </Flex>
    ) : null

  const prompts = facts && isNew && accessOn && newChatProvider ? suggestedPrompts(facts, promptLang(typeof navigator !== 'undefined' ? navigator.languages : [])) : []

  return (
    <Grid templateColumns={{ base: 'minmax(0, 1fr)', lg: '232px minmax(0, 1fr)' }} columnGap={{ lg: 10 }} alignItems="start">
      <Box display={{ base: 'none', lg: 'block' }} position="sticky" top={RAIL_TOP} maxH={`calc(100dvh - ${RAIL_TOP} - 16px)`} overflowY="auto" pr={1} pb={4}>
        {rail}
      </Box>

      <Box minW={0} maxW="var(--container-prose)" w="100%" mx="auto" display="flex" flexDirection="column" minH={{ base: 'calc(100dvh - 220px)', lg: 'calc(100dvh - 200px)' }}>
        {/* Below lg: History and New chat. */}
        <Flex display={{ base: 'flex', lg: 'none' }} justify="space-between" gap={2} mb={4}>
          <Button size="sm" {...outlineButtonProps} leftIcon={<FiClock aria-hidden />} onClick={() => setHistoryOpen(true)} minH="44px" aria-haspopup="dialog">
            {A.rail.history}
          </Button>
          <Button size="sm" {...outlineButtonProps} leftIcon={<FiPlus aria-hidden />} onClick={newChat} minH="44px">
            {A.rail.newChat}
          </Button>
        </Flex>

        <Box mb={6}>
          <Heading as="h2" fontSize={{ base: 'md', md: 'lg' }} fontWeight={600} letterSpacing="-0.01em" wordBreak="break-word" lang={messageLang(header?.title ?? '')}>
            {!conversationId
              ? A.header.newChat
              : notFound
                ? A.header.notFoundTitle
                : run.loadError
                  ? A.header.loadFailedTitle
                  : (header?.title ?? transcript.title ?? <Skeleton as="span" display="inline-block" h="20px" w="200px" />)}
          </Heading>
          {providerName ? (
            <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" mt={1.5} data-privacy-line="">
              {A.header.privacy(providerName, providerHost)}
            </Text>
          ) : null}
          {conversationId && header && !header.providerAvailable ? (
            <Text fontSize="sm" mt={3} color="page.fg-secondary">
              {A.header.providerGone}
            </Text>
          ) : null}
          {notFound ? (
            <Box mt={3} data-conversation-missing="">
              <Text fontSize="sm" color="page.fg-secondary" maxW="60ch">
                {A.header.notFound}
              </Text>
              <Button size="sm" mt={4} {...primaryButtonProps} leftIcon={<FiPlus aria-hidden />} onClick={newChat} minH={{ base: '44px', md: '32px' }}>
                {A.rail.newChat}
              </Button>
            </Box>
          ) : run.loadError && param ? (
            <Box mt={3}>
              <Text fontSize="sm" color="status.error" maxW="60ch">
                {run.loadError}
              </Text>
              <Button size="sm" mt={4} {...outlineButtonProps} onClick={() => void reopen(param)} minH={{ base: '44px', md: '32px' }}>
                {A.retry}
              </Button>
            </Box>
          ) : null}
        </Box>

        <Box flex="1" ref={setLogEl}>
          {loading ? (
            <Box aria-busy="true" aria-label={A.loading}>
              <Skeleton h="18px" w="70%" />
              <Skeleton h="18px" w="55%" mt={3} />
            </Box>
          ) : !conversationId && !accessOn ? (
            <EmptyState title={A.empty.offTitle} body={A.empty.offBody} actions={<Button size="sm" {...primaryButtonProps} onClick={onShowConnections}>{A.empty.openConnections}</Button>} />
          ) : !conversationId && noModels ? (
            <EmptyState
              title={A.empty.noModelTitle}
              body={summary?.assistant && !summary.assistant.canStoreKeys ? `${A.empty.noModelBody} ${A.empty.noSecret}` : A.empty.noModelBody}
              actions={
                <>
                  <Button size="sm" {...primaryButtonProps} onClick={onAddModel} minH={{ base: '44px', md: '32px' }}>
                    {A.empty.addModel}
                  </Button>
                  <Button size="sm" {...outlineButtonProps} onClick={onShowConnections} minH={{ base: '44px', md: '32px' }}>
                    {A.empty.connectApp}
                  </Button>
                </>
              }
            />
          ) : isNew ? (
            <Box>
              <Text fontSize="sm" color="page.fg-secondary" maxW="60ch">
                {A.empty.intro}
              </Text>
              {newChatProvider && status === 'chat-only' ? (
                <Box mt={4} borderLeft="2px solid" borderColor="status.warning" pl={3}>
                  <Text fontSize="sm">{A.empty.chatOnly(newChatProvider.defaultModel ?? newChatProvider.label)}</Text>
                  <Button size="xs" mt={2} {...outlineButtonProps} onClick={onShowModels} minH={{ base: '44px', md: '24px' }}>
                    {A.empty.chooseModel}
                  </Button>
                </Box>
              ) : newChatProvider && status === 'untested' ? (
                <Text fontSize="xs" color="page.fg-secondary" mt={3} maxW="60ch">
                  {A.empty.untested(newChatProvider.defaultModel ?? newChatProvider.label)}
                </Text>
              ) : null}
              {prompts.length ? (
                <Box mt={6}>
                  <Text as="h3" fontFamily={MONO} fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="page.fg-secondary" mb={2}>
                    {A.empty.suggestions}
                  </Text>
                  <Grid templateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={2}>
                    {prompts.map((p) => (
                      <Button
                        key={p}
                        {...outlineButtonProps}
                        size="sm"
                        h="auto"
                        minH="44px"
                        py={2.5}
                        px={3}
                        whiteSpace="normal"
                        textAlign="left"
                        justifyContent="flex-start"
                        fontWeight={400}
                        fontSize="13px"
                        lineHeight="1.45"
                        lang={messageLang(p)}
                        onClick={() => putInComposer(p)}
                      >
                        {p}
                      </Button>
                    ))}
                  </Grid>
                </Box>
              ) : null}
            </Box>
          ) : null}

          {conversationId && !run.loadError ? (
            <MessageList
              transcript={transcript}
              sending={run.sending}
              endNotice={view}
              onAction={act}
              actionLabel={actionLabel}
              usage={usage}
              onChangeState={onChangeState}
              onAskAgain={putInComposer}
              onUnauthorized={toLogin}
              changeRef={changeRef}
              epoch={epoch}
            />
          ) : run.sending ? (
            <MessageList
              transcript={transcript}
              sending={run.sending}
              endNotice={null}
              onAction={act}
              actionLabel={actionLabel}
              usage={null}
              onChangeState={onChangeState}
              onAskAgain={putInComposer}
              onUnauthorized={toLogin}
              changeRef={changeRef}
              epoch={epoch}
            />
          ) : null}
          <Box ref={sentinel} h="1px" aria-hidden />
        </Box>

        {(conversationId || (!noModels && accessOn)) && !loading && !run.loadError ? (
          <>
            <Composer
              value={draft}
              onChange={(value) => {
                // "@" typed at the start or after a space opens + Context; the "@" is not kept.
                if (value.length === draft.length + 1 && value.endsWith('@') && value.slice(0, -1) === draft && (draft === '' || /\s$/.test(draft))) return setPicking(true)
                changeDraft(value)
              }}
              chips={
                <ContextChips
                  chips={chips}
                  dirty={false}
                  onRemove={(c) => {
                    setChips((list) => list.filter((x) => x !== c))
                    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
                  }}
                  add={
                    <ContextPicker
                      chips={chips}
                      onAdd={(c) => setChips((list) => [...list, c])}
                      isOpen={picking}
                      onOpenChange={setPicking}
                      onDone={() => requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))}
                    />
                  }
                />
              }
              onSend={() => void send()}
              onStop={() => void run.stop()}
              onRecall={() => {
                const last = lastUserText(transcript.turns)
                if (last) changeDraft(last)
              }}
              running={running}
              sending={run.sending !== null && !running}
              stopping={run.stopping}
              // Until the conversation in the address is the one shown, nothing can be sent into it.
              disabled={!!disabledReason || run.opening || !coherent}
              disabledReason={disabledReason}
              model={modelControl}
              notice={problemNotice}
              status={statusRow}
              textareaRef={textareaRef}
            />
          </>
        ) : null}
        <VisuallyHidden role="status" aria-live="polite" aria-atomic="true" data-testid="assistant-status">
          {announce}
        </VisuallyHidden>
      </Box>

      <Drawer isOpen={historyOpen} onClose={() => setHistoryOpen(false)} placement="left" size="xs">
        <DrawerOverlay />
        <DrawerContent bg="page.bg" borderRight="1px solid" borderColor="page.border">
          <DrawerCloseButton />
          <DrawerHeader fontSize="md" pb={2}>
            {A.rail.label}
          </DrawerHeader>
          <DrawerBody pb="calc(16px + env(safe-area-inset-bottom, 0px))">{rail}</DrawerBody>
        </DrawerContent>
      </Drawer>

      <AlertDialog isOpen={!!deleting} leastDestructiveRef={deleteCancelRef} onClose={() => setDeleting(null)} isCentered>
        <AlertDialogOverlay>
          <AlertDialogContent bg="page.bg-elevated" border="1px solid" borderColor="page.border" mx={4}>
            <AlertDialogHeader fontSize="md" wordBreak="break-word">
              {deleting ? A.rail.deleteTitle(deleting.title) : ''}
            </AlertDialogHeader>
            <AlertDialogBody fontSize="sm">{A.rail.deleteBody}</AlertDialogBody>
            <AlertDialogFooter gap={2}>
              <Button ref={deleteCancelRef} size="sm" {...outlineButtonProps} onClick={() => setDeleting(null)}>
                {A.rail.cancel}
              </Button>
              <Button size="sm" colorScheme="red" onClick={() => void confirmDelete()} isLoading={deleteBusy}>
                {A.rail.deleteConfirm}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </Grid>
  )
}

function EmptyState({ title, body, actions }: { title: string; body: string; actions: ReactNode }) {
  return (
    <Box border="1px solid" borderColor="page.border" borderRadius="xl" p={{ base: 5, md: 6 }} data-empty-state="">
      <Text fontSize="md" fontWeight={600}>
        {title}
      </Text>
      <Text fontSize="sm" color="page.fg-secondary" mt={1.5} maxW="60ch">
        {body}
      </Text>
      <Flex gap={2} mt={4} flexWrap="wrap">
        {actions}
      </Flex>
    </Box>
  )
}
