import { memo, useCallback, useId, useMemo, useState, type Ref } from 'react'
import { Box, Button, Flex, IconButton, Text, Tooltip, VisuallyHidden } from '@chakra-ui/react'
import { FiCheck, FiCopy, FiPause, FiPlay, FiSquare, FiVolume2 } from 'react-icons/fi'
import { MONO, SavingDots, outlineButtonProps, warnTextProps } from '../shell/ui'
import { MEDIA_COPY } from './media/copy'
import { ImageViewer, MessageMedia } from './media/MessageMedia'
import type { Speech } from './media/voice'
import ChatMarkdown from './ChatMarkdown'
import ChatChange from './ChatChange'
import ToolRow from './ToolRow'
import { ASSISTANT_COPY } from './copy'
import { messageLang, type EndAction, type EndView } from './assistantFormat'
import { changesOfTools, lastUserText, type LiveRun, type Transcript } from './runState'
import type { AssistantDisplay, ChangeState, DeclinedDisplay, DisplayTurn, MediaView, ToolsDisplay, UserDisplay } from './types'

const L = ASSISTANT_COPY.log

/** The owner's message: its files, then a hairline block on the right, at most 85% wide, the text exactly as typed. */
function UserMessage({ display, pending = false, previews, onOpenImage }: { display: UserDisplay; pending?: boolean; previews?: Record<string, string>; onOpenImage?: (id: string) => void }) {
  const media = display.media ?? []
  if (display.continued && !display.text && !media.length) {
    return (
      <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" textAlign="right" data-turn="continued">
        {L.continued}
      </Text>
    )
  }
  const text = display.text ?? ''
  return (
    <Flex justify="flex-end" data-turn="user" data-pending={pending ? 'true' : undefined}>
      <Box maxW={{ base: '92%', md: '85%' }} minW={0} opacity={pending ? 0.7 : 1} transition="opacity 160ms ease">
        {media.length ? <MessageMedia media={media} previews={previews} onOpenImage={onOpenImage} /> : null}
        {text ? (
          <Box
            bg="page.bg-elevated"
            border="1px solid"
            borderColor="page.border"
            borderRadius="2xl"
            borderTopRightRadius={media.length ? '2xl' : 'md'}
            px={4}
            py={2.5}
            fontSize="15px"
            lineHeight="1.6"
            whiteSpace="pre-wrap"
            wordBreak="break-word"
            lang={messageLang(text)}
            data-user-text=""
            ml="auto"
            w="fit-content"
            maxW="100%"
          >
            <VisuallyHidden>{L.you} </VisuallyHidden>
            {text}
          </Box>
        ) : (
          <VisuallyHidden>{L.you}</VisuallyHidden>
        )}
        {display.attachments?.length ? (
          <Flex justify="flex-end" gap={1.5} mt={1.5} flexWrap="wrap" aria-label={L.attachments}>
            {display.attachments.map((a) => (
              <Text key={`${a.kind}:${a.ref}`} as="span" fontFamily={MONO} fontSize="10px" color="page.fg-secondary" border="1px solid" borderColor="page.border" borderRadius="sm" px={1.5}>
                {a.kind} · {a.ref}
              </Text>
            ))}
          </Flex>
        ) : null}
        {display.declined ? (
          <Text fontSize="xs" color="page.fg-secondary" mt={1} textAlign="right">
            {L.declinedMessage}
          </Text>
        ) : null}
        {display.mediaRefused ? (
          <Text fontSize="xs" color="status.warning" mt={1} textAlign="right">
            {MEDIA_COPY.file.refused}
          </Text>
        ) : null}
      </Box>
    </Flex>
  )
}

/** Copy and Read aloud under a finished reply: quiet until hovered or focused (always there on touch). */
function ReplyActions({ id, text, speech }: { id: string; text: string; speech?: Speech }) {
  const [copied, setCopied] = useState(false)
  const reading = speech?.speakingId === id
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }
  const btn = {
    size: 'xs' as const,
    variant: 'ghost' as const,
    color: 'page.fg-secondary',
    _hover: { color: 'page.fg', bg: 'page.hover' },
    minW: { base: '40px', md: '28px' },
    h: { base: '40px', md: '28px' },
    borderRadius: 'md',
  }
  return (
    <Flex
      gap={0.5}
      mt={1.5}
      ml={-1.5}
      opacity={{ base: 1, md: reading ? 1 : 0 }}
      _groupHover={{ opacity: 1 }}
      _focusWithin={{ opacity: 1 }}
      transition="opacity 140ms ease"
      role="toolbar"
      aria-label={MEDIA_COPY.message.actions}
      data-reply-actions=""
    >
      <Tooltip label={copied ? MEDIA_COPY.message.copied : MEDIA_COPY.message.copy} openDelay={300} hasArrow>
        <IconButton aria-label={copied ? MEDIA_COPY.message.copied : MEDIA_COPY.message.copy} icon={copied ? <FiCheck aria-hidden /> : <FiCopy aria-hidden />} {...btn} onClick={() => void copy()} />
      </Tooltip>
      {speech?.supported ? (
        <>
          <Tooltip label={reading ? MEDIA_COPY.speech.stop : MEDIA_COPY.speech.read} openDelay={300} hasArrow>
            <IconButton
              aria-label={reading ? MEDIA_COPY.speech.stop : MEDIA_COPY.speech.read}
              aria-pressed={reading}
              icon={reading ? <FiSquare aria-hidden /> : <FiVolume2 aria-hidden />}
              {...btn}
              color={reading ? 'accent.text' : btn.color}
              onClick={() => (reading ? speech.stop() : void speech.speak(id, text))}
              data-read-aloud=""
            />
          </Tooltip>
          {reading ? (
            <Tooltip label={speech.paused ? MEDIA_COPY.speech.resume : MEDIA_COPY.speech.pause} openDelay={300} hasArrow>
              <IconButton aria-label={speech.paused ? MEDIA_COPY.speech.resume : MEDIA_COPY.speech.pause} icon={speech.paused ? <FiPlay aria-hidden /> : <FiPause aria-hidden />} {...btn} onClick={() => (speech.paused ? speech.resume() : speech.pause())} />
            </Tooltip>
          ) : null}
        </>
      ) : null}
    </Flex>
  )
}

/** Progress notes and reasoning: one collapsed row, plain text inside. */
function Reasoning({ notes }: { notes: string[] }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const kept = notes.filter((n) => n.trim())
  if (!kept.length) return null
  return (
    <Box mb={2}>
      <Button
        variant="unstyled"
        h="auto"
        minH={{ base: '44px', md: '28px' }}
        display="inline-flex"
        alignItems="center"
        gap={2}
        fontFamily={MONO}
        fontSize="12px"
        fontWeight={400}
        color="page.fg-secondary"
        _hover={{ color: 'page.fg' }}
        _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500', outlineOffset: '2px' }}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <Box as="span" aria-hidden display="inline-block" transform={open ? 'rotate(90deg)' : undefined} transition="transform 120ms ease">
          ▸
        </Box>
        {L.reasoning(kept.length)}
      </Button>
      <Box id={id} hidden={!open} mt={1} pl={3} borderLeft="1px solid" borderColor="page.border">
        {kept.map((n, i) => (
          <Text key={i} fontSize="13px" color="page.fg-secondary" whiteSpace="pre-wrap" wordBreak="break-word" mt={i ? 2 : 0} lang={messageLang(n)}>
            {n}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

function AssistantMessage({ display, id, speech }: { display: AssistantDisplay; id?: string; speech?: Speech }) {
  const text = display.text ?? ''
  return (
    <Box data-turn="assistant" role="group">
      <Reasoning notes={display.thinking ?? []} />
      {display.notices?.length
        ? display.notices.map((n, i) => (
            <Text key={i} fontFamily={MONO} fontSize="11px" color="page.fg-secondary" mb={2}>
              {L.fallback(n.from, n.to)}
            </Text>
          ))
        : null}
      {text.trim() ? (
        <Box>
          <VisuallyHidden>{L.assistant} </VisuallyHidden>
          <ChatMarkdown text={text} lang={messageLang(text)} />
        </Box>
      ) : null}
      {display.stopped || display.failed ? (
        <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" mt={1.5}>
          — {display.stopped ? L.stopped : L.cutOff}
        </Text>
      ) : null}
      {display.stoppedEarly ? (
        <Text fontSize="xs" color="page.fg-secondary" mt={1.5}>
          {L.stoppedEarly}
        </Text>
      ) : null}
      {id && text.trim() && !display.stopped && !display.failed ? <ReplyActions id={id} text={text} speech={speech} /> : null}
    </Box>
  )
}

function DeclinedMessage({ display }: { display: DeclinedDisplay }) {
  return (
    <Box data-turn="declined" borderLeft="2px solid" borderColor="status.warning" pl={3} py={0.5}>
      <Text fontSize="sm">{display.filter ? L.filtered : L.declined}</Text>
      {display.explanation ? (
        <Text fontSize="sm" color="page.fg-secondary" mt={1} whiteSpace="pre-wrap" wordBreak="break-word">
          {display.explanation}
        </Text>
      ) : null}
      {display.category ? (
        <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" mt={1}>
          {L.category(display.category)}
        </Text>
      ) : null}
    </Box>
  )
}

function ToolsBlock({ display }: { display: ToolsDisplay }) {
  return (
    <Box data-turn="tools">
      {(display.results ?? []).map((r) => (
        <ToolRow key={r.id} name={r.name} title={r.title} state={r.ok ? 'ok' : 'error'} code={r.code} args={r.args} result={r.result} />
      ))}
    </Box>
  )
}

/** The turn being written: notes as they come, the text, running tools, notices. */
function LiveBlock({ live }: { live: LiveRun }) {
  const note = live.thinkingOpen ? live.thinking[live.thinking.length - 1] ?? '' : ''
  const text = live.text
  return (
    <Box data-turn="live" aria-busy="true">
      {live.thinking.length && !text ? (
        <Flex align="baseline" gap={2} fontFamily={MONO} fontSize="12px" color="page.fg-secondary" mb={2} minW={0}>
          <Text as="span" flexShrink={0}>
            {L.thinking}
            <SavingDots />
          </Text>
          {note ? (
            <Text as="span" noOfLines={1} minW={0} fontFamily="body" lang={messageLang(note)}>
              {note.trim().split('\n').pop()}
            </Text>
          ) : null}
        </Flex>
      ) : null}
      {live.notices
        .filter((n) => n.kind !== 'fallback' || (n.from && n.to))
        .map((n, i) => (
          <Text key={i} fontFamily={MONO} fontSize="11px" color="page.fg-secondary" mb={2}>
            {n.kind === 'fallback' && n.from && n.to ? L.fallback(n.from, n.to) : n.message}
          </Text>
        ))}
      {text ? <ChatMarkdown text={text} lang={messageLang(text)} /> : null}
      {!text && !live.thinking.length && !live.tools.length ? (
        <Text fontFamily={MONO} fontSize="12px" color="page.fg-secondary" aria-hidden>
          <SavingDots />
        </Text>
      ) : null}
      {live.tools.length ? (
        <Box mt={text ? 3 : 0}>
          {live.tools.map((tool) => (
            <ToolRow key={tool.id} name={tool.name} title={tool.title} state={!tool.done ? 'running' : tool.ok ? 'ok' : 'error'} code={tool.code} />
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

const TONE: Record<EndView['tone'], { border: string; text?: Record<string, unknown> }> = {
  info: { border: 'page.border-strong' },
  warning: { border: 'status.warning', text: warnTextProps },
  error: { border: 'status.error' },
}

function EndNotice({ view, onAction, actionLabel }: { view: EndView; onAction: (a: EndAction) => void; actionLabel: (a: EndAction) => string }) {
  return (
    <Box borderLeft="2px solid" borderColor={TONE[view.tone].border} pl={3} py={1} data-run-end={view.tone}>
      <Text fontSize="sm" fontWeight={500}>
        {view.line}
      </Text>
      {view.detail && view.detail !== view.line ? (
        <Text fontSize="sm" color="page.fg-secondary" mt={1} whiteSpace="pre-wrap" wordBreak="break-word">
          {view.detail}
        </Text>
      ) : null}
      {view.providerSaid ? (
        <Box mt={2}>
          <Text fontSize="xs" color="page.fg-secondary">
            {ASSISTANT_COPY.end.providerSaid}
          </Text>
          <Text fontFamily={MONO} fontSize="12px" color="page.fg-secondary" whiteSpace="pre-wrap" wordBreak="break-word" mt={0.5}>
            {view.providerSaid}
          </Text>
        </Box>
      ) : null}
      {view.action ? (
        <Button size="sm" mt={3} {...outlineButtonProps} onClick={() => onAction(view.action as EndAction)} minH={{ base: '44px', md: '32px' }}>
          {actionLabel(view.action)}
        </Button>
      ) : null}
    </Box>
  )
}

/**
 * The conversation (PRODUCT §4.1, §4.2): the owner's messages, the
 * assistant's replies (ChatMarkdown), tool rows, the cards of the changes it
 * made or proposed, and the turn being written. `role="log"` without live
 * announcements (no tokens are read out: the page's one polite status line
 * speaks instead); the turn being written is aria-busy.
 */
function MessageList({
  transcript,
  sending,
  endNotice,
  onAction,
  actionLabel,
  usage,
  onChangeState,
  onAskAgain,
  onUnauthorized,
  changeRef,
  epoch,
  sendingMedia,
  previews,
  speech,
}: {
  transcript: Transcript
  /** The message on its way (until the server's own turn replaces it). */
  sending: string | null
  /** The files of the message on its way. */
  sendingMedia?: readonly MediaView[]
  /** Local previews of images just sent, by file id (drawn until the server's copy loads). */
  previews?: Record<string, string>
  /** Reading replies aloud (absent: no Read aloud button). */
  speech?: Speech
  endNotice: EndView | null
  onAction: (a: EndAction) => void
  actionLabel: (a: EndAction) => string
  usage: string | null
  onChangeState: (id: string, state: ChangeState, title: string) => void
  onAskAgain: (text: string) => void
  onUnauthorized: () => void
  /** The first waiting card registers here, so the status line's Review can move the focus to it. */
  changeRef: (id: string) => Ref<HTMLDivElement>
  /** Bumped when a run ends, so the change cards read their state again. */
  epoch: number
}) {
  const turns = transcript.turns
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')?.seq ?? null
  // Every image of the conversation, in order: the viewer steps through them.
  const images = useMemo(() => {
    const out: MediaView[] = []
    for (const t of turns) {
      const d = t.display as UserDisplay
      if (t.role === 'user' && d.kind === 'user') for (const m of d.media ?? []) if (m.kind === 'image') out.push(m)
    }
    return out
  }, [turns])
  const [viewing, setViewing] = useState<string | null>(null)
  const openImage = useCallback((id: string) => setViewing(id), [])
  return (
    <Box role="log" aria-live="off" aria-label={L.label} display="flex" flexDirection="column" gap={5} data-transcript="">
      {turns.map((turn: DisplayTurn) => {
        const d = turn.display as { kind?: string }
        if (turn.role === 'user' && d.kind === 'user') return <UserMessage key={turn.seq} display={turn.display as UserDisplay} previews={previews} onOpenImage={openImage} />
        if (d.kind === 'declined') return <DeclinedMessage key={turn.seq} display={turn.display as DeclinedDisplay} />
        if (turn.role === 'assistant' && d.kind === 'assistant') {
          return (
            <Box key={turn.seq}>
              <AssistantMessage display={turn.display as AssistantDisplay} id={`${transcript.conversationId ?? 'new'}:${turn.seq}`} speech={speech} />
              {usage && turn.seq === lastAssistant && !transcript.live ? (
                <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" mt={2} aria-label={`${L.usage.label}: ${usage}`} data-usage-line="">
                  {usage}
                </Text>
              ) : null}
            </Box>
          )
        }
        if (turn.role === 'tool' && d.kind === 'tools') {
          const display = turn.display as ToolsDisplay
          const ids = changesOfTools(display)
          return (
            <Box key={turn.seq} mt={-2}>
              <ToolsBlock display={display} />
              {ids.length ? (
                <Box display="flex" flexDirection="column" gap={3} mt={3}>
                  {ids.map((id) => (
                    <ChatChange
                      key={id}
                      id={id}
                      ref={changeRef(id)}
                      epoch={epoch}
                      onState={onChangeState}
                      onUnauthorized={onUnauthorized}
                      onAskAgain={() => {
                        const text = lastUserText(turns, turn.seq)
                        if (text) onAskAgain(text)
                      }}
                    />
                  ))}
                </Box>
              ) : null}
            </Box>
          )
        }
        return null
      })}
      {sending !== null && (sending || sendingMedia?.length) ? (
        <UserMessage display={{ kind: 'user', text: sending, continued: false, attachments: [], media: sendingMedia ? [...sendingMedia] : [] }} pending previews={previews} />
      ) : null}
      {transcript.live ? <LiveBlock live={transcript.live} /> : null}
      {endNotice && !transcript.live ? <EndNotice view={endNotice} onAction={onAction} actionLabel={actionLabel} /> : null}
      {images.length ? <ImageViewer images={images} openId={viewing} onClose={() => setViewing(null)} /> : null}
    </Box>
  )
}

export default memo(MessageList)
