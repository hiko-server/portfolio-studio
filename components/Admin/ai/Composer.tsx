import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Box, Button, Flex, Text, Textarea, VisuallyHidden } from '@chakra-ui/react'
import { KbdHint, MONO, primaryButtonProps } from '../shell/ui'
import { useBottomBarOffset } from '../../Common/useBottomBarOffset'
import { ASSISTANT_COPY } from './copy'
import { composerKey } from './assistantFormat'
import { MEDIA_COPY } from './media/copy'

const C = ASSISTANT_COPY.composer

/** The longest message the server takes (lib/ai/runs MESSAGE_MAX). */
export const MESSAGE_MAX = 100_000

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * The message box (design §8.4, PRODUCT §4.5). Enter sends and Shift+Enter
 * breaks the line; a key that belongs to an input method's composition never
 * sends — the owner writes Chinese, and that Enter only confirms the
 * characters (isComposing, keyCode 229, and the composition events, for the
 * browser that reports the confirming Enter after compositionend). On a touch
 * device Enter is a new line and the button sends. While an answer is being
 * written the button is Stop (Esc too) and the box stays editable, so the
 * owner can write the next message. ↑ in an empty box recalls the last one.
 * It grows with its text to 40% of the screen, then scrolls; it sits at the
 * bottom of the page as the conversation scrolls (sticky), clear of a
 * phone's home indicator, and publishes its height (useBottomBarOffset) so the
 * back-to-top button and toasts float above it. It never takes the focus by itself except when the
 * owner asked for it (a suggestion, Ask again).
 */
export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  onRecall,
  running,
  sending = false,
  stopping,
  disabled,
  disabledReason,
  model,
  notice,
  status,
  textareaRef,
  chips,
  inPanel = false,
  id = 'ai-composer',
  tray,
  tools,
  strip,
  onFiles,
  hasFiles = false,
  waitingFiles = false,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onRecall: () => void
  running: boolean
  /** A message (or Retry) is on its way and the run has not started yet. */
  sending?: boolean
  stopping: boolean
  /** Nothing can be sent (and the reason is shown under the box). */
  disabled: boolean
  disabledReason: string | null
  /** The model line: a picker for a new chat, the conversation's own model otherwise. */
  model: ReactNode
  /** A line above the box (a refusal of the last send). */
  notice?: ReactNode
  /** The status row above the box: changes waiting for the owner, Jump to latest (never over the conversation). */
  status?: ReactNode
  textareaRef: RefObject<HTMLTextAreaElement>
  /** Chips attached to the next message (ContextChips), shown inside the box above the text. */
  chips?: ReactNode
  /** In the Ask AI panel: it sits at the panel's foot, not the page's, and the page's floating controls stay put. */
  inPanel?: boolean
  /** The text area's id (one message box per page: the panel's has its own). */
  id?: string
  /** The files attached to the next message (AttachmentTray), inside the box above the text. */
  tray?: ReactNode
  /** The box's own tools, at the start of its foot: attach, dictate, voice mode. */
  tools?: ReactNode
  /** A line at the top of the box: words being dictated, or a voice message being recorded. */
  strip?: ReactNode
  /** Files pasted or dropped onto the box. */
  onFiles?: (files: File[]) => void
  /** Files are ready to go: the message may be sent without words. */
  hasFiles?: boolean
  /** Files are still on their way: Send waits for them. */
  waitingFiles?: boolean
  placeholder?: string
}) {
  const composing = useRef(false)
  const bar = useRef<HTMLDivElement>(null)
  const noBar = useRef<HTMLDivElement>(null)
  // The page's floating controls (back to top, toasts) sit above the box instead of over its Send button.
  useBottomBarOffset(inPanel ? noBar : bar)
  const whyId = `${id}-why`
  const [touch, setTouch] = useState(false)
  const tooLong = value.length > MESSAGE_MAX
  const canSend = !disabled && !running && !sending && (!!value.trim() || hasFiles) && !tooLong && !waitingFiles
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const filesOf = (dt: DataTransfer | null): File[] => {
    if (!dt) return []
    const out: File[] = []
    for (const item of Array.from(dt.items ?? [])) {
      if (item.kind !== 'file') continue
      const f = item.getAsFile()
      if (f) out.push(f)
    }
    return out.length ? out : Array.from(dt.files ?? [])
  }
  const hasDraggedFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).includes('Files')

  useEffect(() => {
    try {
      setTouch(window.matchMedia('(hover: none) and (pointer: coarse)').matches)
    } catch {
      setTouch(false)
    }
  }, [])

  // Grow with the text, up to 40% of the screen (CSS caps it; past that it scrolls).
  useIsoLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [value, textareaRef])

  return (
    <Box
      ref={bar}
      position={inPanel ? 'relative' : 'sticky'}
      bottom={inPanel ? undefined : 0}
      zIndex={5}
      mt={inPanel ? 0 : 6}
      pt={3}
      pb="calc(12px + env(safe-area-inset-bottom, 0px))"
      bg="page.surface"
      backdropFilter={inPanel ? undefined : 'saturate(180%) blur(14px)'}
      className="no-print"
      data-composer={inPanel ? 'panel' : ''}
    >
      {notice}
      {status}
      <Box
        position="relative"
        border="1px solid"
        borderColor={dragging ? 'accent.500' : 'page.border-strong'}
        borderRadius="2xl"
        bg="page.bg"
        boxShadow={dragging ? '0 0 0 3px var(--chakra-colors-accent-500)' : 'elevation.sm'}
        transition="border-color 120ms ease, box-shadow 120ms ease"
        _focusWithin={{ borderColor: 'accent.500', boxShadow: '0 0 0 1px var(--chakra-colors-accent-500), var(--elevation-sm)' }}
        onDragEnter={
          onFiles
            ? (e) => {
                if (!hasDraggedFiles(e.dataTransfer)) return
                e.preventDefault()
                dragDepth.current++
                setDragging(true)
              }
            : undefined
        }
        onDragOver={
          onFiles
            ? (e) => {
                if (!hasDraggedFiles(e.dataTransfer)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }
            : undefined
        }
        onDragLeave={
          onFiles
            ? () => {
                dragDepth.current = Math.max(0, dragDepth.current - 1)
                if (!dragDepth.current) setDragging(false)
              }
            : undefined
        }
        onDrop={
          onFiles
            ? (e) => {
                if (!hasDraggedFiles(e.dataTransfer)) return
                e.preventDefault()
                dragDepth.current = 0
                setDragging(false)
                const files = filesOf(e.dataTransfer)
                if (files.length) onFiles(files)
              }
            : undefined
        }
        data-dragging={dragging ? 'true' : undefined}
      >
        {dragging ? (
          <Flex position="absolute" inset={0} zIndex={2} borderRadius="2xl" bg="page.surface" backdropFilter="blur(4px)" align="center" justify="center" direction="column" gap={1} pointerEvents="none" textAlign="center" px={4}>
            <Text fontSize="sm" fontWeight={600}>
              {MEDIA_COPY.attach.drop}
            </Text>
            <Text fontSize="xs" color="page.fg-secondary">
              {MEDIA_COPY.attach.dropHint}
            </Text>
          </Flex>
        ) : null}
        {strip}
        {chips}
        {tray}
        <VisuallyHidden as="label" htmlFor={id}>
          {C.label}
        </VisuallyHidden>
        <Textarea
          id={id}
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? C.placeholder}
          rows={1}
          resize="none"
          border="none"
          bg="transparent"
          _focus={{ boxShadow: 'none', border: 'none' }}
          _focusVisible={{ boxShadow: 'none', border: 'none' }}
          px={4}
          pt={3}
          pb={1}
          minH="48px"
          maxH={inPanel ? '30dvh' : '40dvh'}
          overflowY="auto"
          fontSize="15px"
          lineHeight="1.55"
          aria-describedby={disabledReason || tooLong || waitingFiles ? whyId : undefined}
          aria-invalid={tooLong || undefined}
          onPaste={
            onFiles
              ? (e) => {
                  // A screenshot or a copied file: attached, not pasted as text. Anything that carries text — cells
                  // from a spreadsheet, a paragraph from Word or Keynote, which also put a picture of themselves on
                  // the clipboard — pastes as text, as always.
                  const types = Array.from(e.clipboardData?.types ?? [])
                  if (types.includes('text/plain') || types.includes('text/html')) return
                  const files = filesOf(e.clipboardData)
                  if (!files.length) return
                  e.preventDefault()
                  onFiles(files)
                }
              : undefined
          }
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            // Some browsers fire the confirming Enter's keydown after compositionend: let that keydown pass first.
            window.setTimeout(() => {
              composing.current = false
            }, 0)
          }}
          onKeyDown={(e) => {
            const action = composerKey(e.nativeEvent, { composing: composing.current, touch, running, empty: value === '' })
            if (action === 'none') return
            if (action === 'recall') {
              e.preventDefault()
              onRecall()
              return
            }
            if (action === 'stop') {
              e.preventDefault()
              onStop()
              return
            }
            // Enter: never a new line here; sends only when it can (never while an answer is being written).
            e.preventDefault()
            if (canSend) onSend()
          }}
        />
        <Flex align="center" justify="space-between" gap={2} px={2} pb={2} pt={1} flexWrap="wrap">
          {tools ? (
            <Flex align="center" gap={0.5} flexShrink={0}>
              {tools}
            </Flex>
          ) : null}
          <Box minW={0} flex="1 1 140px" pl={tools ? 1 : 2}>
            {model}
          </Box>
          <Flex align="center" gap={3} ml="auto">
            {!touch ? (
              <Flex gap={3} display={{ base: 'none', md: 'flex' }}>
                <KbdHint keys={['↵']} label={C.sendKey} />
                <KbdHint keys={['⇧', '↵']} label={C.newLineKey} />
              </Flex>
            ) : null}
            {running ? (
              <Button
                size="sm"
                variant="outline"
                borderColor="page.border-strong"
                color="page.fg"
                _hover={{ bg: 'page.bg-overlay' }}
                onClick={onStop}
                isLoading={stopping}
                loadingText={C.stopping}
                aria-keyshortcuts="Escape"
                minH={{ base: '44px', md: '32px' }}
                minW="72px"
                data-testid="composer-stop"
              >
                <Box as="span" aria-hidden w="8px" h="8px" bg="currentColor" borderRadius="1px" mr={2} />
                {C.stop}
              </Button>
            ) : (
              <Button
                size="sm"
                {...primaryButtonProps}
                onClick={onSend}
                isDisabled={!canSend && !sending}
                isLoading={sending}
                loadingText={C.send}
                aria-keyshortcuts="Enter"
                minH={{ base: '44px', md: '32px' }}
                minW="72px"
                data-testid="composer-send"
              >
                {C.send}
              </Button>
            )}
          </Flex>
        </Flex>
      </Box>
      {disabledReason || tooLong || waitingFiles ? (
        <Text id={whyId} fontSize="xs" color="page.fg-secondary" mt={2} px={1}>
          {tooLong ? C.tooLong(MESSAGE_MAX) : (disabledReason ?? MEDIA_COPY.attach.waiting)}
        </Text>
      ) : null}
    </Box>
  )
}

/** The model line for a conversation already under way: its own model, fixed (a conversation never changes model). */
export function PinnedModel({ label }: { label: string }) {
  return (
    <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" noOfLines={1} title={C.pinned}>
      <VisuallyHidden>{C.pinned}: </VisuallyHidden>
      {label}
    </Text>
  )
}
