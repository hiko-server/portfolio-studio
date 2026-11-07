import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import NextLink from 'next/link'
import { Box, Button, Flex, FormControl, FormHelperText, FormLabel, Heading, Link, Stack, Text, Textarea, useToast } from '@chakra-ui/react'
import { MONO, RevalidatedPaths, inputProps, outlineButtonProps, primaryButtonProps } from '../shell/ui'
import { loginHref, readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import UndoToast, { UNDO_MS } from '../shell/UndoToast'
import { isOwnKey, isTextEntryTarget } from '../shell/listKeys'
import { useStepUp } from '../security/useStepUp'
import { wasStepUpCancelled } from '../security/stepUpClient'
import { getShortcutsEnabled, isImeComposing } from '../../../lib/keyboardShortcuts'
import { CHANGES_COPY, CHANGE_STATE_COPY, LINK_FLAG_COPY } from './copy'
import {
  actorText,
  changeDiff,
  compactDiff,
  decidedLine,
  effectLine,
  formatMoment,
  heldOf,
  historyHref,
  historyLinks,
  kindCopy,
  livePaths,
  scheduleOf,
  titleParts,
  undoLines,
} from './changeFormat'
import { DocHeader, JsonDiffRows, MdxDiff } from './ChangeDiffView'
import ChangeReviewSheet from './ChangeReviewSheet'
import { sinceTime } from './format'
import { useArmedAction } from './useArmedAction'
import type { ChangeDetail, ChangeState } from './types'

/** The mono state chip of a change (the uppercase style of ShareLinks' StateChip), shared with the Changes rows. */
const STATE_TONE: Record<ChangeState, { color: string; border: string; dark?: string }> = {
  waiting: { color: 'accent.text', border: 'accent.500' },
  applying: { color: 'page.fg-secondary', border: 'page.border-strong' },
  applied: { color: 'green.700', border: 'green.500', dark: 'green.300' },
  rejected: { color: 'page.fg-secondary', border: 'page.border-strong' },
  expired: { color: 'page.fg-secondary', border: 'page.border-strong' },
  conflict: { color: 'orange.700', border: 'orange.400', dark: 'orange.300' },
  failed: { color: 'red.600', border: 'red.400', dark: 'red.300' },
  undone: { color: 'page.fg-secondary', border: 'page.border-strong' },
  voided: { color: 'page.fg-secondary', border: 'page.border-strong' },
  in_editor: { color: 'accent.text', border: 'accent.500' },
}

export function ChangeStateChip({ state }: { state: ChangeState }) {
  const t = STATE_TONE[state] ?? STATE_TONE.voided
  return (
    <Text
      as="span"
      fontFamily={MONO}
      fontSize="9px"
      letterSpacing="0.08em"
      textTransform="uppercase"
      color={t.color}
      _dark={t.dark ? { color: t.dark } : undefined}
      border="1px solid"
      borderColor={t.border}
      borderRadius="3px"
      px="5px"
      lineHeight="16px"
      flexShrink={0}
      whiteSpace="nowrap"
      data-state={state}
    >
      {CHANGE_STATE_COPY[state] ?? state}
    </Text>
  )
}

/** A moment as a <time> with the full date on hover, as on the Security page. */
export function When({ iso, now, prefix }: { iso: string | null; now: number; prefix?: string }) {
  if (!iso) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  return (
    <time dateTime={iso} title={formatMoment(iso)}>
      {prefix ? `${prefix} ` : ''}
      {sinceTime(at, now)}
    </time>
  )
}

/** A tiny external store for the undo toast: its button follows whether this change can still be undone. */
function useUndoStore(undoable: boolean) {
  const store = useRef<{ value: boolean; listeners: Set<() => void> }>({ value: undoable, listeners: new Set() })
  useEffect(() => {
    store.current.value = undoable
    store.current.listeners.forEach((fn) => fn())
  }, [undoable])
  return useMemo(
    () => ({
      subscribe: (cb: () => void) => {
        store.current.listeners.add(cb)
        return () => {
          store.current.listeners.delete(cb)
        }
      },
      isCurrent: () => store.current.value,
    }),
    [],
  )
}

/** The places a multi-document change's documents keep their own history (§8.2: "No single undo" lists them). */
function HistoryLinks({ links }: { links: Array<{ label: string; href: string }> }) {
  if (!links.length) return null
  return (
    <Box as="ul" listStyleType="none" display="flex" flexWrap="wrap" columnGap={3} rowGap={1} mt={1} aria-label={CHANGES_COPY.histories}>
      {links.map((l) => (
        <Box as="li" key={l.href} fontFamily={MONO} fontSize="11px">
          <Link as={NextLink} href={l.href} color="accent.text">
            {l.label}
          </Link>
        </Box>
      ))}
    </Box>
  )
}

export type ChangeCardVariant = 'panel' | 'row' | 'page'

/**
 * One AI change, as the owner decides it (design §5.3, §8.2; PRODUCT §4.3).
 * One component for the Changes view (`row`: the row above is its header),
 * the review page (`page`: the page's title is the headline) and, from
 * stage M4, the chat (`panel`: a hairline card of its own).
 *
 * Everything on it is computed by the server except the model's rationale,
 * which is quoted as “The model says:”. Approve names the effect, carries
 * the preview hash the card was loaded with, and is armed by
 * useArmedAction (visible for a second, in a focused window, with a pointer
 * or keyboard focus inside); a change longer than the card can show stays
 * unapprovable until the review sheet has been scrolled to its end. A
 * destructive change asks "Confirm it's you" first (fetchWithStepUp). The
 * card never takes the focus when it appears; A and R act inside it while
 * single-key shortcuts are on.
 */
export default function ChangeCard({
  change,
  reload,
  variant = 'panel',
  onDismiss,
  onDecided,
}: {
  change: ChangeDetail
  /** Load this change again (after a decision, or when the server says the card is stale). */
  reload: () => Promise<void>
  variant?: ChangeCardVariant
  /** Conflict and other final states in a list: collapse the card. */
  onDismiss?: () => void
  /** A decision reached the server (approve, reject, undo): lists refresh their counts. */
  onDecided?: (state: ChangeState) => void
}) {
  const toast = useToast()
  const { fetchWithStepUp, stepUpElement } = useStepUp()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<'approve' | 'reject' | 'undo' | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [sheetOpen, setSheetOpen] = useState(false)
  // The sheet mounts on its first opening and stays (its closing animation needs it).
  const [sheetMounted, setSheetMounted] = useState(false)
  const [readHash, setReadHash] = useState<string | null>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const reviewButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  useEffect(() => {
    if (sheetOpen) setSheetMounted(true)
  }, [sheetOpen])

  const preview = change.preview
  const waiting = change.state === 'waiting'
  const diff = useMemo(() => (preview ? changeDiff(preview) : null), [preview])
  const compact = useMemo(() => (diff ? compactDiff(diff) : null), [diff])
  const truncated = !!compact?.truncated
  const read = readHash === change.preview_sha256
  const { ref: armRef, armed } = useArmedAction<HTMLDivElement>(waiting && !!preview)
  const kc = kindCopy(change.kind)
  const destructive = change.risk === 'destructive'
  const actor = actorText(change.actor)
  const undo = undoLines(change.kind)
  const canUndo = change.state === 'applied' && change.undo.available
  const undoStore = useUndoStore(canUndo)
  const needsRead = truncated && !read
  const canApprove = waiting && !!preview && armed && !needsRead && busy === null
  const unitWord = diff ? CHANGES_COPY.unit(diff.changed, diff.unit) : ''

  const toLogin = () => {
    window.location.href = loginHref(`${window.location.pathname}${window.location.search}`)
  }

  const failToast = (title: string, res: Response | null, json: Record<string, unknown> = {}) => {
    if (res?.status === 401) return toLogin()
    toast({ status: 'error', title, description: typeof json.error === 'string' ? json.error : res ? `HTTP ${res.status}` : NETWORK_ERROR, duration: 6000, isClosable: true })
  }

  const post = (path: string, body: unknown, stepUpReason?: string) => {
    const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' }
    const url = `/api/admin/ai/changes/${change.id}/${path}`
    return stepUpReason ? fetchWithStepUp(url, init, stepUpReason) : fetch(url, init)
  }

  const runUndo = async () => {
    setBusy('undo')
    try {
      const res = await fetch(`/api/admin/ai/changes/${change.id}/undo`, { method: 'POST', credentials: 'same-origin' })
      const json = await readJsonObject(res)
      if (!res.ok) {
        failToast(CHANGES_COPY.toast.couldntUndo, res, json)
        await reload()
        return
      }
      toast({ status: 'success', title: CHANGES_COPY.toast.undone, description: change.title })
      onDecided?.('undone')
      await reload()
    } catch {
      failToast(CHANGES_COPY.toast.couldntUndo, null)
    } finally {
      setBusy(null)
    }
  }

  /** From the card (armed here) or from the review sheet (armed there, and read to its end). */
  const approve = async (fromSheet = false) => {
    if (!preview || !waiting || busy !== null || (fromSheet ? !read : !canApprove)) return
    setBusy('approve')
    try {
      const res = await post('approve', { preview_sha256: change.preview_sha256 }, destructive ? CHANGES_COPY.stepUp(change.kind, change.target.ref) : undefined)
      if (wasStepUpCancelled(res)) return
      const json = await readJsonObject(res)
      if (res.ok) {
        setSheetOpen(false)
        onDecided?.('applied')
        const title = CHANGES_COPY.toast.applied(kc.done, change.target.ref)
        toast({
          id: `ai-undo-${change.id}`,
          duration: UNDO_MS,
          position: 'bottom',
          render: ({ onClose }) => (
            <UndoToast
              title={title}
              subscribe={undoStore.subscribe}
              isCurrent={undoStore.isCurrent}
              undoHint={CHANGES_COPY.toast.undoGone}
              onUndo={() => {
                onClose()
                void runUndo()
              }}
            />
          ),
        })
        await reload()
        return
      }
      if (res.status === 409 && json.code === 'STALE_CARD') {
        toast({ status: 'warning', title: CHANGES_COPY.toast.notApplied, description: CHANGES_COPY.toast.stale, duration: 8000, isClosable: true })
        await reload()
        return
      }
      if (res.status === 409) {
        // Expired, voided, conflict, failed or decided elsewhere: the card shows the state the server holds now.
        onDecided?.((typeof json.state === 'string' ? json.state : 'waiting') as ChangeState)
        await reload()
        if (json.code === 'CONFLICT' || json.code === 'FAILED') return
        failToast(CHANGES_COPY.toast.notApplied, res, json)
        return
      }
      failToast(CHANGES_COPY.toast.notApplied, res, json)
    } catch {
      failToast(CHANGES_COPY.toast.notApplied, null)
    } finally {
      setBusy(null)
    }
  }

  const reject = async () => {
    setBusy('reject')
    try {
      const res = await post('reject', note.trim() ? { note: note.trim() } : {})
      const json = await readJsonObject(res)
      if (!res.ok) {
        failToast(CHANGES_COPY.toast.notRejected, res, json)
        if (res.status === 409) await reload()
        return
      }
      setRejecting(false)
      setNote('')
      toast({ status: 'success', title: CHANGES_COPY.toast.rejected, description: change.title })
      onDecided?.('rejected')
      await reload()
    } catch {
      failToast(CHANGES_COPY.toast.notRejected, null)
    } finally {
      setBusy(null)
    }
  }

  const openReject = () => {
    setRejecting(true)
    // The owner asked for the field: move there (a card never takes the focus on its own).
    requestAnimationFrame(() => noteRef.current?.focus())
  }

  // A / R inside the card, while single-key shortcuts are on and no text field has the focus. React bubbles keys
  // through portals: the review sheet and the "Confirm it's you" dialog are not the card, and their keys stay theirs.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isOwnKey(e.currentTarget, e.target)) return
    if (!waiting || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isImeComposing(e.nativeEvent)) return
    if (!getShortcutsEnabled() || isTextEntryTarget(e.target)) return
    const k = e.key.toLowerCase()
    if (k === 'a' && canApprove) {
      e.preventDefault()
      void approve()
    } else if (k === 'r' && !rejecting) {
      e.preventDefault()
      openReject()
    }
  }

  const showHeader = variant !== 'row'
  const showHeadline = variant === 'panel'
  const [pre, ref, post2] = titleParts(change.title, change.target)
  const headingId = `change-${change.id}-title`
  const held = preview ? heldOf(preview) : null
  const schedule = preview ? scheduleOf(preview) : null
  const checks = change.notes.publish_checks ?? null
  const live = livePaths(change)
  const history = historyHref(change)
  const decided = decidedLine(change)

  const approveLabel = needsRead ? CHANGES_COPY.readFirst(diff?.changed ?? 0, unitWord) : kc.approve

  return (
    <Box
      ref={armRef}
      role="group"
      aria-labelledby={showHeadline ? headingId : undefined}
      aria-label={showHeadline ? undefined : change.title}
      onKeyDown={onKeyDown}
      data-change-id={change.id}
      data-change-state={change.state}
      {...(variant === 'panel' ? { border: '1px solid', borderColor: 'page.border', borderRadius: 'xl', bg: 'page.bg', p: { base: 4, md: 5 } } : {})}
    >
      {showHeader ? (
        <Flex align="center" justify="space-between" gap={3} flexWrap="wrap" mb={showHeadline ? 2 : 3}>
          <Flex align="center" gap={2} minW={0}>
            {variant === 'panel' ? (
              <Text as="span" fontFamily={MONO} fontSize="10px" letterSpacing="0.16em" textTransform="uppercase" color="accent.text">
                {CHANGES_COPY.eyebrow}
                {waiting ? (
                  <Box as="span" color="page.fg" ml={2}>
                    {CHANGES_COPY.waitingForYou}
                  </Box>
                ) : null}
              </Text>
            ) : null}
            {variant !== 'panel' || !waiting ? <ChangeStateChip state={change.state} /> : null}
          </Flex>
          <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" minW={0}>
            {/* On the review page the title already names who asked. */}
            {variant === 'panel' ? `${actor} · ` : null}
            <When iso={change.created_at} now={now} />
          </Text>
        </Flex>
      ) : null}

      {showHeadline ? (
        <Heading as="h3" id={headingId} fontSize="md" fontWeight={600} letterSpacing="-0.01em" wordBreak="break-word">
          {pre}
          {ref ? (
            <Text as="span" fontFamily={MONO} fontSize="0.92em" fontWeight={500}>
              {ref}
            </Text>
          ) : null}
          {post2}
        </Heading>
      ) : null}

      {/* Decided: one line of what happened (PRODUCT §4.3 "Done"). */}
      {change.state === 'applied' ? (
        <Box mt={showHeadline ? 2 : 0} data-testid="change-done">
          <Flex align="center" gap={3} flexWrap="wrap">
            <Text fontSize="sm">
              {kc.done}{' '}
              <Text as="span" fontFamily={MONO} fontSize="13px">
                {change.target.ref}
              </Text>
              {change.result?.approvedOn ? (
                <Text as="span" color="page.fg-secondary">
                  {' '}
                  · approved on {change.result.approvedOn}
                </Text>
              ) : null}
            </Text>
            {canUndo ? (
              <Button size="xs" {...outlineButtonProps} onClick={() => void runUndo()} isLoading={busy === 'undo'} loadingText={CHANGES_COPY.undoing}>
                {CHANGES_COPY.undo}
              </Button>
            ) : change.undo.available === false && change.undo.code === 'CHANGED_SINCE' ? (
              <Text fontSize="xs" color="page.fg-secondary">
                {CHANGES_COPY.changedSince}{' '}
                {history ? (
                  <Link as={NextLink} href={history} color="accent.text">
                    {CHANGES_COPY.openHistory}
                  </Link>
                ) : null}
              </Text>
            ) : change.undo.available === false && change.undo.code === 'NO_UNDO' ? (
              <Text fontSize="xs" color="page.fg-secondary">
                {undo.line}
              </Text>
            ) : null}
          </Flex>
          {change.undo.available === false && change.undo.code === 'NO_UNDO' && preview ? <HistoryLinks links={historyLinks(preview)} /> : null}
          {live.length ? (
            <Box mt={2}>
              <RevalidatedPaths paths={live} />
            </Box>
          ) : null}
          {canUndo && undo.fetched ? (
            <Text fontSize="xs" color="page.fg-secondary" mt={2}>
              {CHANGES_COPY.undoLine.fetched}
            </Text>
          ) : null}
        </Box>
      ) : decided ? (
        <Box mt={showHeadline ? 2 : 0} data-testid="change-decided">
          <Text fontSize="sm" fontWeight={change.state === 'conflict' ? 600 : 400}>
            {decided}
          </Text>
          {change.state === 'conflict' ? (
            <Text fontSize="sm" color="page.fg-secondary" mt={1}>
              {CHANGES_COPY.state.conflictNothing} {change.actor.kind === 'mcp' ? CHANGES_COPY.state.conflictApp(actor) : null}
            </Text>
          ) : null}
          {change.state === 'rejected' && change.reject_note ? (
            <Text fontSize="sm" color="page.fg-secondary" mt={1} whiteSpace="pre-wrap" wordBreak="break-word">
              {CHANGES_COPY.state.rejectedNote} “{change.reject_note}”
            </Text>
          ) : null}
          {onDismiss && change.state === 'conflict' ? (
            <Button size="xs" mt={3} {...outlineButtonProps} onClick={onDismiss}>
              {CHANGES_COPY.dismiss}
            </Button>
          ) : null}
        </Box>
      ) : null}

      {/* Waiting: everything the owner approves, then the actions. */}
      {waiting && preview && diff && compact ? (
        <Stack spacing={3} mt={showHeadline ? 1.5 : 0}>
          <Text fontSize="sm" color="page.fg-secondary">
            {effectLine(preview)}
          </Text>

          {checks && checks.length ? (
            <Box as="ul" listStyleType="none" display="flex" flexWrap="wrap" columnGap={4} rowGap={1} aria-label={CHANGES_COPY.flags.checks} fontSize="12px">
              {checks.map((c) => (
                <Flex as="li" key={c.id} gap={1.5} align="baseline" title={c.detail}>
                  <Text as="span" fontWeight={700} color={c.level === 'ok' ? 'status.open' : c.level === 'warning' ? 'status.warning' : 'status.error'} aria-hidden>
                    {c.level === 'ok' ? '✓' : c.level === 'warning' ? '!' : '×'}
                  </Text>
                  <Text as="span">
                    <Box as="span" srOnly>
                      {c.level === 'ok' ? 'Passed: ' : c.level === 'warning' ? 'Warning: ' : 'Blocking: '}
                    </Box>
                    {c.label}
                  </Text>
                </Flex>
              ))}
            </Box>
          ) : null}

          {compact.docs.length ? (
            <Stack spacing={3}>
              {compact.docs.map((d) => (
                <Box key={d.doc.ref}>
                  <DocHeader doc={d.doc} />
                  {d.format === 'mdx' ? <MdxDiff lines={d.lines} context={1} /> : <JsonDiffRows entries={d.entries} />}
                </Box>
              ))}
              {truncated ? (
                <Button variant="link" size="sm" alignSelf="flex-start" color="accent.text" fontFamily={MONO} fontSize="12px" fontWeight={500} onClick={() => setSheetOpen(true)}>
                  ⋯ {diff.changed - compact.shown > 0 ? CHANGES_COPY.more(diff.changed - compact.shown, CHANGES_COPY.unit(diff.changed - compact.shown, diff.unit)) : CHANGES_COPY.reviewAll}
                </Button>
              ) : null}
            </Stack>
          ) : null}

          {/* Flags: what deserves a second look, all server-computed. */}
          {preview.newLinks.length || preview.newEmbeds.length || preview.zeroWidth || change.notes.ai_written_earlier || held || schedule || preview.effects.import || preview.effects.hiddenValuesChanged ? (
            <Box borderLeft="2px solid" borderColor="status.warning" pl={3} py={0.5} data-testid="change-flags">
              <Text fontFamily={MONO} fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="page.fg-secondary" mb={1}>
                {CHANGES_COPY.flags.title}
              </Text>
              <Stack spacing={1} fontSize="13px">
                {held ? (
                  <Text>{held.held === 'scheduled' ? CHANGES_COPY.flags.heldScheduled(formatMoment(held.publish_at)) : CHANGES_COPY.flags.heldReviewLink(held.active_links)}</Text>
                ) : null}
                {schedule ? (
                  <Text>
                    {schedule.cleared
                      ? CHANGES_COPY.flags.scheduleCleared
                      : [schedule.publishAt ? CHANGES_COPY.flags.scheduleLive(formatMoment(schedule.publishAt)) : '', schedule.unpublishAt ? CHANGES_COPY.flags.scheduleOff(formatMoment(schedule.unpublishAt)) : ''].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
                {preview.effects.import ? <Text overflowWrap="anywhere">{CHANGES_COPY.flags.importFrom(preview.effects.import.url)}</Text> : null}
                {preview.newLinks.length ? (
                  <Box>
                    <Text as="span">{CHANGES_COPY.flags.newLinks}:</Text>
                    <Box as="ul" listStyleType="none" mt={0.5}>
                      {preview.newLinks.map((l) => (
                        <Box as="li" key={l.url} fontFamily={MONO} fontSize="12px" overflowWrap="anywhere">
                          {l.url}
                          {l.flags.map((f) => (
                            <Text as="span" key={f} ml={2} color="status.warning" fontFamily={MONO} whiteSpace="nowrap">
                              ⚑ {LINK_FLAG_COPY[f] ?? f}
                            </Text>
                          ))}
                        </Box>
                      ))}
                    </Box>
                  </Box>
                ) : null}
                {preview.newEmbeds.length ? (
                  <Box>
                    <Text as="span">{CHANGES_COPY.flags.newEmbeds}:</Text>
                    <Box as="ul" listStyleType="none" mt={0.5}>
                      {preview.newEmbeds.map((u) => (
                        <Box as="li" key={u} fontFamily={MONO} fontSize="12px" overflowWrap="anywhere">
                          {u}
                        </Box>
                      ))}
                    </Box>
                  </Box>
                ) : null}
                {preview.zeroWidth ? <Text>{CHANGES_COPY.flags.zeroWidth(preview.zeroWidth)}</Text> : null}
                {preview.effects.hiddenValuesChanged ? <Text>{CHANGES_COPY.flags.hiddenValues(preview.effects.hiddenValuesChanged)}</Text> : null}
                {change.notes.ai_written_earlier ? (
                  <Text>
                    {CHANGES_COPY.flags.aiEarlier}{' '}
                    <Link as={NextLink} href={`/admin/ai/change/${change.notes.ai_written_earlier}`} color="accent.text">
                      {CHANGES_COPY.openChange}
                    </Link>
                  </Text>
                ) : null}
              </Stack>
            </Box>
          ) : null}

          {change.rationale ? (
            <Text fontSize="sm" wordBreak="break-word" whiteSpace="pre-wrap">
              <Text as="span" color="page.fg-secondary">
                {CHANGES_COPY.modelSays}{' '}
              </Text>
              “{change.rationale}”
            </Text>
          ) : null}

          <Box>
            <Flex align="baseline" justify="space-between" gap={3} flexWrap="wrap">
              <Text fontSize="xs" color="page.fg-secondary">
                {undo.line}
              </Text>
              {preview.documents.length ? (
                <Button ref={reviewButtonRef} variant="link" size="sm" color="accent.text" fontSize="13px" onClick={() => setSheetOpen(true)}>
                  {CHANGES_COPY.reviewAll} →
                </Button>
              ) : null}
            </Flex>
            {undo.multi ? <HistoryLinks links={historyLinks(preview)} /> : null}
            {undo.fetched ? (
              <Text fontSize="xs" color="page.fg-secondary" mt={1}>
                {CHANGES_COPY.undoLine.fetched}
              </Text>
            ) : null}
            {change.expires_at ? (
              <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" mt={1}>
                {CHANGES_COPY.expires(formatMoment(change.expires_at))}
              </Text>
            ) : null}
          </Box>

          {rejecting ? (
            <Box as="form" onSubmit={(e: React.FormEvent) => (e.preventDefault(), void reject())}>
              <FormControl>
                <FormLabel fontSize="12px" fontWeight={500} mb={1.5} htmlFor={`reject-${change.id}`}>
                  {CHANGES_COPY.rejectNote}
                </FormLabel>
                <Textarea
                  id={`reject-${change.id}`}
                  ref={noteRef}
                  value={note}
                  onChange={(e) => setNote(e.target.value.slice(0, 500))}
                  maxLength={500}
                  rows={2}
                  fontSize="sm"
                  {...inputProps}
                  aria-describedby={`reject-${change.id}-help`}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setRejecting(false)
                    }
                  }}
                />
                <FormHelperText id={`reject-${change.id}-help`} fontSize="12px" color="page.fg-secondary">
                  {CHANGES_COPY.rejectNoteHelp}
                </FormHelperText>
              </FormControl>
              <Flex gap={2} mt={3} flexDirection={{ base: 'column', sm: 'row' }}>
                <Button type="submit" size="sm" colorScheme="red" variant="outline" isLoading={busy === 'reject'} minH={{ base: '44px', sm: 'auto' }}>
                  {CHANGES_COPY.rejectConfirm}
                </Button>
                <Button size="sm" {...outlineButtonProps} onClick={() => setRejecting(false)} minH={{ base: '44px', sm: 'auto' }}>
                  {CHANGES_COPY.rejectCancel}
                </Button>
              </Flex>
            </Box>
          ) : (
            <Box>
              <Flex gap={2} flexDirection={{ base: 'column', sm: 'row' }} align={{ base: 'stretch', sm: 'center' }} flexWrap="wrap">
                <Button
                  size="sm"
                  {...(destructive ? { colorScheme: 'red' } : primaryButtonProps)}
                  isDisabled={!canApprove}
                  isLoading={busy === 'approve'}
                  loadingText={CHANGES_COPY.approving}
                  onClick={() => void approve()}
                  minH={{ base: '44px', sm: 'auto' }}
                  whiteSpace="normal"
                  aria-keyshortcuts="A"
                  aria-describedby={needsRead ? `change-${change.id}-read` : undefined}
                  data-testid="change-approve"
                  data-armed={armed ? 'true' : 'false'}
                >
                  {approveLabel}
                </Button>
                <Button size="sm" {...outlineButtonProps} onClick={openReject} isDisabled={busy !== null} minH={{ base: '44px', sm: 'auto' }} aria-keyshortcuts="R">
                  {CHANGES_COPY.reject}
                </Button>
              </Flex>
              {needsRead ? (
                <Text id={`change-${change.id}-read`} fontSize="xs" color="page.fg-secondary" mt={2}>
                  {CHANGES_COPY.readHint}
                </Text>
              ) : null}
            </Box>
          )}
        </Stack>
      ) : null}

      {/* Decided changes keep their diff for the record: Review all opens it read-only. */}
      {!waiting && preview && preview.documents.length ? (
        <Button variant="link" size="sm" color="accent.text" fontSize="13px" mt={3} onClick={() => setSheetOpen(true)}>
          {CHANGES_COPY.reviewAll} →
        </Button>
      ) : null}

      {preview && diff && (sheetOpen || sheetMounted) ? (
        <ChangeReviewSheet
          isOpen={sheetOpen}
          onClose={() => setSheetOpen(false)}
          finalFocusRef={reviewButtonRef}
          change={change}
          diff={diff}
          onReadToEnd={() => setReadHash(change.preview_sha256)}
          approve={
            waiting
              ? {
                  label: kc.approve,
                  destructive,
                  busy: busy === 'approve',
                  blocked: busy !== null && busy !== 'approve',
                  read,
                  onApprove: () => void approve(true),
                  onReject: () => {
                    setSheetOpen(false)
                    openReject()
                  },
                }
              : null
          }
        />
      ) : null}
      {stepUpElement}
    </Box>
  )
}
