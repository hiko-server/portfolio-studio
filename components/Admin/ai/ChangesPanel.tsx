import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertIcon, Box, Button, Flex, Select, Skeleton, Spinner, Text } from '@chakra-ui/react'
import SegmentedTabs, { tabPanelProps, type SegmentedItem } from '../shell/SegmentedTabs'
import { MONO, outlineButtonProps } from '../shell/ui'
import { loginHref, readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { useListKeyboard } from '../shell/useListKeyboard'
import { relativeTime } from '../security/securityFormat'
import { AI_COPY, CHANGES_COPY, CHANGE_AREA_COPY } from './copy'
import AiStatusStrip from './AiStatusStrip'
import { assistantTile } from './assistantFormat'
import ChangeCard, { ChangeStateChip, When } from './ChangeCard'
import { actorText, titleParts } from './changeFormat'
import { listKey, listUrl, receivePage, shownCursor, shownRows, type ChangesSegment as Segment, type ListPage } from './changesList'
import type { AccessState, AppView, AssistantSummary, CatalogueTool, ChangeDetail, ChangeListItem, ChangeState, ToolCallRow } from './types'

type Summary = { access: AccessState; apps: { connected: number; lastUsedAt: number | null }; waiting: number | null; assistant?: AssistantSummary | null }

class Unauthorized extends Error {}

const RETURN_PATH = '/admin/ai?view=changes'

async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal })
  if (res.status === 401) throw new Unauthorized()
  const json = await readJsonObject(res)
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
  return json
}

/** "1.2 kB", "860 B". */
function bytes(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} kB`
  return `${(n / 1_000_000).toFixed(1)} MB`
}

/** A row's title: the server's words, the target's reference in mono (as on the card). */
function RowTitle({ title, target }: { title: string; target: { kind: string; ref: string } }) {
  const [pre, ref, post] = titleParts(title, target)
  return (
    <>
      {pre}
      {ref ? (
        <Text as="span" fontFamily={MONO} fontSize="0.92em">
          {ref}
        </Text>
      ) : null}
      {post}
    </>
  )
}

/** One expanded row's card: its detail, loaded when it opens and again after each decision. */
function ExpandedChange({ id, onLoaded, onDecided, onDismiss }: { id: string; onLoaded: (c: ChangeDetail) => void; onDecided: (state: ChangeState) => void; onDismiss: () => void }) {
  const [detail, setDetail] = useState<ChangeDetail | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const json = (await getJson(`/api/admin/ai/changes/${id}`)) as unknown as ChangeDetail
      setDetail(json)
      setError('')
      onLoaded(json)
    } catch (err) {
      if (err instanceof Unauthorized) {
        window.location.href = loginHref(RETURN_PATH)
        return
      }
      setError(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : NETWORK_ERROR)
    }
  }, [id, onLoaded])

  useEffect(() => {
    void load()
  }, [load])

  if (error && !detail) {
    return (
      <Alert status="error" variant="left-accent" borderRadius="md" bg="page.bg-elevated" fontSize="sm" alignItems="center" gap={2} flexWrap="wrap">
        <AlertIcon />
        <AlertDescription flex={1}>{CHANGES_COPY.page.loadError(error)}</AlertDescription>
        <Button size="xs" {...outlineButtonProps} onClick={() => void load()}>
          {CHANGES_COPY.page.retry}
        </Button>
      </Alert>
    )
  }
  if (!detail) {
    return (
      <Box aria-busy="true" aria-label={CHANGES_COPY.page.loading}>
        <Skeleton h="14px" w="70%" />
        <Skeleton h="120px" mt={3} borderRadius="md" />
      </Box>
    )
  }
  return <ChangeCard change={detail} reload={load} variant="row" onDecided={onDecided} onDismiss={onDismiss} />
}

/**
 * Admin → AI → Changes (design §8.1, PRODUCT §6): `Waiting (n) | Done | All
 * calls`, filtered by app and area. A row is relative time, the app, the
 * server's title and the state; Enter or a click opens its change card
 * below it (one at a time). J / K move between rows; A and R act inside an
 * open card. Waiting changes come oldest first, decided ones newest first.
 * All calls is the read log of the last 30 days: tool and target only.
 * A list shows only under the segment and filters it was loaded for, and an
 * answer for a list no longer on screen is dropped (changesList.ts).
 */
export default function ChangesPanel({ onShowConnections, onWaiting }: { onShowConnections?: () => void; onWaiting?: (n: number | null) => void }) {
  const [segment, setSegment] = useState<Segment>('waiting')
  const [app, setApp] = useState('')
  const [area, setArea] = useState('')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [apps, setApps] = useState<AppView[]>([])
  const [tools, setTools] = useState<CatalogueTool[]>([])
  const [changesPage, setChangesPage] = useState<ListPage<ChangeListItem> | null>(null)
  const [callsPage, setCallsPage] = useState<ListPage<ToolCallRow> | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // The list on screen is the one for this segment and these filters; anything loaded for another shows nothing.
  const key = listKey({ segment, app, area })
  const keyRef = useRef(key)
  keyRef.current = key
  // The loads of the list on screen: aborted as soon as the segment or a filter changes.
  const abortRef = useRef<AbortController | null>(null)
  const items = shownRows(changesPage, key)
  const calls = shownRows(callsPage, key)
  const cursor = segment === 'calls' ? shownCursor(callsPage, key) : shownCursor(changesPage, key)
  const listError = error && error.key === key ? error.message : ''

  // A new segment or filter closes the open card in the same update: no frame shows the old list's card.
  const selectSegment = (next: Segment) => {
    setOpen(null)
    setSegment(next)
  }
  const selectApp = (next: string) => {
    setOpen(null)
    setApp(next)
  }
  const selectArea = (next: string) => {
    setOpen(null)
    setArea(next)
  }

  const toLogin = () => {
    window.location.href = loginHref(RETURN_PATH)
  }

  const loadSummary = useCallback(async () => {
    try {
      setSummary((await getJson('/api/admin/ai/summary')) as unknown as Summary)
    } catch (err) {
      if (err instanceof Unauthorized) toLogin()
    }
  }, [])

  /** The first page of the list on screen (`from` null), or its next page. */
  const loadList = useCallback(
    async (from: string | null) => {
      const q = { segment, app, area }
      const k = listKey(q)
      const signal = abortRef.current?.signal
      try {
        const json = await getJson(listUrl(q, from), signal)
        // Another segment, filter or page was chosen meanwhile: this answer is for a list no longer on screen.
        if (signal?.aborted || keyRef.current !== k) return
        const page = { key: k, from, cursor: typeof json.next_cursor === 'string' ? json.next_cursor : null }
        if (q.segment === 'calls') {
          const rows = Array.isArray(json.items) ? (json.items as ToolCallRow[]) : []
          setCallsPage((shown) => receivePage(shown, keyRef.current, { ...page, rows }))
        } else {
          const rows = Array.isArray(json.items) ? (json.items as ChangeListItem[]) : []
          setChangesPage((shown) => receivePage(shown, keyRef.current, { ...page, rows }))
          if (typeof json.waiting === 'number') setSummary((s) => (s ? { ...s, waiting: json.waiting } : s))
        }
        setError(null)
        setNow(Date.now())
      } catch (err) {
        if (signal?.aborted || keyRef.current !== k) return
        if (err instanceof Unauthorized) return toLogin()
        setError({ key: k, message: err instanceof Error && err.message !== 'Failed to fetch' ? err.message : NETWORK_ERROR })
      }
    },
    [segment, app, area],
  )

  useEffect(() => {
    void loadSummary()
    // App names for the filter, and tool titles for All calls (from the server's catalogue, never hand-written).
    void getJson('/api/admin/ai/tokens')
      .then((j) => setApps(Array.isArray(j.apps) ? (j.apps as AppView[]) : []))
      .catch((err) => err instanceof Unauthorized && toLogin())
    void getJson('/api/admin/ai/catalogue')
      .then((j) => setTools(Array.isArray(j.tools) ? (j.tools as CatalogueTool[]) : []))
      .catch(() => {})
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(tick)
  }, [loadSummary])

  useEffect(() => {
    const ctl = new AbortController()
    abortRef.current = ctl
    void loadList(null)
    return () => ctl.abort()
  }, [loadList])

  const rows = useMemo(() => items ?? [], [items])
  const kb = useListKeyboard({
    count: segment === 'calls' ? 0 : rows.length,
    global: true,
    onOpen: (i) => {
      const id = rows[i]?.id
      if (id) setOpen((o) => (o === id ? null : id))
    },
  })

  // A decision in an open card: its row shows the new state at once; the counts follow.
  const onLoaded = useCallback((c: ChangeDetail) => {
    setChangesPage((page) => (page ? { ...page, rows: page.rows.map((it) => (it.id === c.id ? { ...it, state: c.state, code: c.code, reject_note: c.reject_note } : it)) } : page))
  }, [])
  const onDecided = useCallback(() => {
    void loadSummary()
  }, [loadSummary])

  const appOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const a of apps) seen.set(a.id, a.name)
    for (const it of rows) if (!seen.has(it.actor.id)) seen.set(it.actor.id, actorText(it.actor))
    for (const c of calls ?? []) if (!seen.has(c.actor_id)) seen.set(c.actor_id, c.actor_label)
    return Array.from(seen.entries())
  }, [apps, rows, calls])
  const toolTitle = useMemo(() => new Map(tools.map((t) => [t.name, t.title])), [tools])

  const waiting = summary?.waiting ?? null
  useEffect(() => {
    if (summary) onWaiting?.(summary.waiting)
  }, [summary, onWaiting])
  const v = CHANGES_COPY.view
  const segments: SegmentedItem<Segment>[] = [
    { key: 'waiting', label: v.waiting(waiting) },
    { key: 'done', label: v.done },
    { key: 'calls', label: v.calls },
  ]
  const access = summary?.access

  let index = -1
  return (
    <Box>
      <Box mb={6}>
        {summary && access ? (
          <AiStatusStrip
            tiles={[
              { label: AI_COPY.strip.waiting, value: waiting === null ? '—' : String(waiting), sub: AI_COPY.strip.waitingSub(waiting) },
              {
                label: AI_COPY.strip.access,
                value: access.enabled && !access.blocked ? AI_COPY.strip.on : AI_COPY.strip.off,
                sub: AI_COPY.strip.accessSub(access),
                action: onShowConnections ? { label: AI_COPY.tabs.connections, onClick: onShowConnections } : undefined,
              },
              assistantTile(summary.assistant ?? null),
              {
                label: AI_COPY.strip.apps,
                value: String(summary.apps.connected),
                sub: AI_COPY.strip.appsSub(summary.apps.connected, summary.apps.lastUsedAt ? relativeTime(summary.apps.lastUsedAt, now) : null),
              },
            ]}
          />
        ) : (
          <Skeleton h="76px" borderRadius="xl" />
        )}
      </Box>

      <Flex gap={3} align="center" justify="space-between" flexWrap="wrap" mb={4}>
        <SegmentedTabs items={segments} value={segment} onSelect={selectSegment} label={v.segmentsLabel} idPrefix="ai-changes" size="sm" />
        <Flex gap={2} flex={{ base: '1 1 100%', md: '0 1 auto' }}>
          <Select size="sm" aria-label={v.app} value={app} onChange={(e) => selectApp(e.target.value)} w={{ base: 'auto', md: '190px' }} flex={{ base: '1 1 0', md: '0 0 auto' }} minW={0}>
            <option value="">{v.anyApp}</option>
            {appOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
          {segment !== 'calls' ? (
            <Select size="sm" aria-label={v.area} value={area} onChange={(e) => selectArea(e.target.value)} w={{ base: 'auto', md: '170px' }} flex={{ base: '1 1 0', md: '0 0 auto' }} minW={0}>
              <option value="">{v.anyArea}</option>
              {Object.entries(CHANGE_AREA_COPY).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          ) : null}
        </Flex>
      </Flex>

      <Box {...tabPanelProps('ai-changes', segment)}>
        {listError && (segment === 'calls' ? !calls : !items) ? (
          <Alert status="error" variant="left-accent" borderRadius="md" bg="page.bg-elevated" alignItems="center" gap={2} flexWrap="wrap">
            <AlertIcon />
            <AlertDescription fontSize="sm" flex={1}>
              {v.loadError(listError)}
            </AlertDescription>
            <Button size="sm" {...outlineButtonProps} onClick={() => void loadList(null)}>
              {AI_COPY.retry}
            </Button>
          </Alert>
        ) : segment === 'calls' ? (
          calls === null ? (
            <Flex h="20vh" align="center" justify="center" role="status" aria-label={AI_COPY.tabs.loadingChanges}>
              <Spinner color="accent.500" />
            </Flex>
          ) : (
            <Box>
              <Text fontSize="xs" color="page.fg-secondary" mb={3}>
                {v.callsHint}
              </Text>
              {calls.length === 0 ? (
                <Text fontSize="sm" color="page.fg-secondary" py={6}>
                  {v.emptyCalls}
                </Text>
              ) : (
                <Box as="ul" listStyleType="none" border="1px solid" borderColor="page.border" borderRadius="lg" data-testid="ai-calls">
                  {calls.map((c) => (
                    <Flex
                      as="li"
                      key={c.id}
                      px={4}
                      py={2.5}
                      gap={{ base: 1, md: 4 }}
                      flexDirection={{ base: 'column', md: 'row' }}
                      align={{ base: 'stretch', md: 'baseline' }}
                      borderBottom="1px solid"
                      borderColor="page.border"
                      _last={{ borderBottom: 'none' }}
                      fontSize="13px"
                    >
                      <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" w={{ md: '92px' }} flexShrink={0}>
                        <When iso={c.at} now={now} />
                      </Text>
                      <Text flex="1 1 auto" minW={0} wordBreak="break-word">
                        {toolTitle.get(c.tool) ?? c.tool}
                        {c.target ? (
                          <Text as="span" fontFamily={MONO} fontSize="12px" color="page.fg-secondary" ml={2} wordBreak="break-all">
                            {c.target}
                          </Text>
                        ) : null}
                      </Text>
                      <Text color="page.fg-secondary" flexShrink={0} maxW={{ md: '200px' }} noOfLines={1}>
                        {c.actor_label}
                      </Text>
                      <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" className="tnum" flexShrink={0}>
                        {c.ms} ms · {bytes(c.bytes_out)}
                      </Text>
                      <Text
                        fontFamily={MONO}
                        fontSize="11px"
                        flexShrink={0}
                        color={c.outcome === 'ok' ? 'page.fg-secondary' : 'status.error'}
                        data-outcome={c.outcome}
                      >
                        {v.outcome[c.outcome] ?? c.outcome}
                        {c.code ? ` · ${c.code}` : ''}
                      </Text>
                    </Flex>
                  ))}
                </Box>
              )}
            </Box>
          )
        ) : items === null ? (
          <Flex h="20vh" align="center" justify="center" role="status" aria-label={AI_COPY.tabs.loadingChanges}>
            <Spinner color="accent.500" />
          </Flex>
        ) : rows.length === 0 ? (
          <Box py={8} textAlign={{ base: 'left', md: 'center' }}>
            <Text fontSize="sm" fontWeight={600}>
              {app || area ? v.emptyFiltered : segment === 'waiting' ? v.emptyWaiting : v.emptyDone}
            </Text>
            {segment === 'waiting' && !app && !area ? (
              <Text fontSize="sm" color="page.fg-secondary" mt={1} maxW="56ch" mx={{ md: 'auto' }}>
                {v.emptyWaitingHint}
              </Text>
            ) : null}
          </Box>
        ) : (
          <Box as="ul" listStyleType="none" border="1px solid" borderColor="page.border" borderRadius="lg" {...kb.listProps} aria-label={v.label} data-testid="ai-changes">
            {rows.map((it) => {
              index++
              const i = index
              const expanded = open === it.id
              return (
                <Box as="li" key={it.id} borderBottom="1px solid" borderColor="page.border" _last={{ borderBottom: 'none' }} data-row-change={it.id}>
                  <Box
                    as="button"
                    type="button"
                    {...kb.itemProps(i)}
                    onClick={() => setOpen(expanded ? null : it.id)}
                    aria-expanded={expanded}
                    aria-controls={`ai-change-${it.id}`}
                    display="grid"
                    gridTemplateColumns={{ base: 'minmax(0, 1fr) auto', md: '96px minmax(0, 1fr) auto auto' }}
                    gridTemplateAreas={{ base: '"title chip" "meta meta"', md: '"when title app chip"' }}
                    columnGap={4}
                    rowGap={1}
                    alignItems="baseline"
                    w="100%"
                    textAlign="left"
                    px={4}
                    py={3}
                    minH="44px"
                    bg={expanded ? 'page.bg-elevated' : 'transparent'}
                    _hover={{ bg: 'page.bg-elevated' }}
                    _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500', outlineOffset: '-2px' }}
                    borderRadius={0}
                  >
                    <Text gridArea={{ base: 'meta', md: 'when' }} fontFamily={MONO} fontSize="11px" color="page.fg-secondary" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
                      <When iso={it.created_at} now={now} />
                      <Box as="span" display={{ base: 'inline', md: 'none' }}>
                        {' · '}
                        {actorText(it.actor)}
                      </Box>
                    </Text>
                    <Text gridArea="title" fontSize="sm" fontWeight={500} minW={0} overflowWrap="anywhere">
                      <RowTitle title={it.title} target={it.target} />
                    </Text>
                    <Box gridArea="app" display={{ base: 'none', md: 'block' }} maxW="200px" minW={0}>
                      <Text fontSize="13px" color="page.fg-secondary" noOfLines={1}>
                        {actorText(it.actor)}
                      </Text>
                    </Box>
                    <Box gridArea="chip" justifySelf="end">
                      <ChangeStateChip state={it.state} />
                    </Box>
                  </Box>
                  {expanded ? (
                    <Box id={`ai-change-${it.id}`} px={4} pt={1} pb={5} bg="page.bg-elevated">
                      <ExpandedChange id={it.id} onLoaded={onLoaded} onDecided={onDecided} onDismiss={() => setOpen(null)} />
                    </Box>
                  ) : null}
                </Box>
              )
            })}
          </Box>
        )}
        {cursor ? (
          <Button
            size="sm"
            mt={4}
            {...outlineButtonProps}
            isLoading={loadingMore}
            onClick={async () => {
              setLoadingMore(true)
              await loadList(cursor)
              setLoadingMore(false)
            }}
          >
            {v.more}
          </Button>
        ) : null}
        {segment !== 'calls' && rows.length ? (
          <Text fontSize="xs" color="page.fg-secondary" mt={3} display={{ base: 'none', md: 'block' }}>
            {v.keys}
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}
