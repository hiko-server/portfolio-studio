import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, IconButton, Modal, ModalContent, ModalOverlay, Switch, Text, VisuallyHidden } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { FiMic, FiMicOff, FiX } from 'react-icons/fi'
import { MONO } from '../../shell/ui'
import { MEDIA_COPY } from './copy'
import { joinDictated, useDictation, type Speech } from './voice'

const V = MEDIA_COPY.voice
/** How long a pause after the last finished phrase means "I'm done": then the words are sent. */
const SILENCE_MS = 1_400

type Phase = 'listening' | 'sending' | 'thinking' | 'speaking' | 'paused'

const breathe = keyframes`0%,100% { transform: scale(1); } 50% { transform: scale(1.06); }`
const spin = keyframes`from { transform: rotate(0deg); } to { transform: rotate(360deg); }`
const ripple = keyframes`0% { transform: scale(0.9); opacity: 0.55; } 100% { transform: scale(1.6); opacity: 0; }`

/**
 * Voice mode: a hands-free conversation. It listens (dictation), sends what
 * was said once the owner pauses, shows the assistant thinking, reads the
 * reply aloud, and listens again. Tapping the orb interrupts the reading or
 * pauses listening; Esc ends it. Everything the transcript would show is
 * still written there (the conversation behind it): a change that waits for
 * approval is approved on screen, never by voice.
 */
export default function VoiceMode({
  isOpen,
  onClose,
  onSend,
  running,
  latestReply,
  speech,
  lang,
  blockedReason,
  waitingApproval,
  problem,
}: {
  isOpen: boolean
  onClose: () => void
  /** Send what was said as a message. Resolves true once the server took it. */
  onSend: (text: string) => Promise<boolean>
  /** An answer is being written in this conversation. */
  running: boolean
  /** The newest finished reply of the conversation (`key` changes with each). */
  latestReply: { key: string; text: string } | null
  speech: Speech
  lang: string
  blockedReason: string | null
  waitingApproval: boolean
  /** How the last answer ended when it did not finish (or why the last send was refused): said instead of listening on. */
  problem: string | null
}) {
  const [phase, setPhase] = useState<Phase>('paused')
  const [heard, setHeard] = useState('')
  const [autoRead, setAutoRead] = useState(true)
  const [said, setSaid] = useState('')
  /** One line about what just happened when nothing is read aloud (a problem, or "the reply is on screen"). */
  const [notice, setNotice] = useState<string | null>(null)
  const heardRef = useRef('')
  const openRef = useRef(isOpen)
  openRef.current = isOpen
  const problemRef = useRef(problem)
  problemRef.current = problem
  const timer = useRef<number | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const replyAtSend = useRef<string | null>(null)
  const sawRun = useRef(false)

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }

  const dictation = useDictation({
    lang,
    onFinal: (phrase) => {
      heardRef.current = joinDictated(heardRef.current, phrase)
      setHeard(heardRef.current)
      armSend()
    },
  })
  const dictationRef = useRef(dictation)
  dictationRef.current = dictation

  const send = useCallback(async () => {
    clearTimer()
    const text = heardRef.current.trim()
    if (!text || phaseRef.current !== 'listening') return
    dictationRef.current.stop()
    setPhase('sending')
    setSaid(text)
    replyAtSend.current = latestReplyRef.current?.key ?? null
    sawRun.current = false
    const ok = await onSend(text)
    // Closed (or interrupted) while the message was on its way: nothing goes on behind the closed dialog.
    if (!openRef.current || (phaseRef.current as Phase) !== 'sending') return
    if (!ok) {
      // Refused before it started: the words stay, with why, for another try.
      setNotice(problemRef.current ?? V.blocked)
      setPhase('paused')
      return
    }
    heardRef.current = ''
    setHeard('')
    setPhase('thinking')
  }, [onSend])
  const sendRef = useRef(send)
  sendRef.current = send

  function armSend() {
    clearTimer()
    timer.current = window.setTimeout(() => void sendRef.current(), SILENCE_MS)
  }

  const latestReplyRef = useRef(latestReply)
  latestReplyRef.current = latestReply

  const listen = useCallback(() => {
    if (!openRef.current) return
    speech.stop()
    heardRef.current = ''
    setHeard('')
    setNotice(null)
    setPhase('listening')
    dictationRef.current.start()
  }, [speech])

  // Opening starts listening (or, while an answer is being written, waits for it and reads it); closing stops
  // everything: the microphone, the reading, any pending send.
  useEffect(() => {
    if (isOpen) {
      setNotice(null)
      if (running) {
        replyAtSend.current = latestReplyRef.current?.key ?? null
        sawRun.current = true
        setPhase('thinking')
      } else if (!blockedReason) listen()
      else setPhase('paused')
    } else {
      clearTimer()
      dictationRef.current.stop({ discard: true })
      speech.stop()
      phaseRef.current = 'paused'
      setPhase('paused')
      setSaid('')
      heardRef.current = ''
      setHeard('')
    }
    // Only on open and close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // A phrase still being heard holds the send back.
  useEffect(() => {
    if (phase === 'listening' && dictation.interim) clearTimer()
    else if (phase === 'listening' && heardRef.current && timer.current === null) armSend()
    // armSend reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictation.interim, phase])

  // The answer: once its run ended, read the new reply aloud and listen again. An answer that did not finish is
  // said (and read) instead, and voice mode pauses: the owner decides what next, on screen.
  useEffect(() => {
    if (!isOpen || phase !== 'thinking') return
    if (running) {
      sawRun.current = true
      return
    }
    if (!sawRun.current) return
    const reply = latestReply && latestReply.key !== replyAtSend.current ? latestReply : null
    if (problem) {
      setNotice(problem)
      setPhase('paused')
      if (autoRead && speech.supported) void speech.speak('voice:problem', problem)
      return
    }
    if (reply && autoRead && speech.supported) {
      setPhase('speaking')
      void speech.speak(`voice:${reply.key}`, reply.text).then((finished) => {
        if (finished && phaseRef.current === 'speaking') listen()
      })
    } else {
      listen()
      if (reply) setNotice(V.replied)
    }
  }, [isOpen, phase, running, latestReply, problem, autoRead, speech, listen])

  // The dictation failed (permission, network): pause and say why.
  useEffect(() => {
    if (dictation.error && phase === 'listening') setPhase('paused')
  }, [dictation.error, phase])

  const tap = () => {
    if (blockedReason) return
    if (phase === 'speaking') return listen()
    if (phase === 'listening') {
      if (heardRef.current.trim()) return void send()
      dictation.stop()
      clearTimer()
      return setPhase('paused')
    }
    if (phase === 'paused') return listen()
  }

  const line =
    blockedReason ?? dictation.error ?? (phase === 'listening' ? V.listening : phase === 'sending' ? V.heard : phase === 'thinking' ? V.thinking : phase === 'speaking' ? V.speaking : (notice ?? V.paused))
  const active = phase === 'listening' || phase === 'speaking'
  // What a tap does now, as its name: the orb and the mic button say the same.
  const tapLabel = phase === 'speaking' ? V.interrupt : phase === 'listening' ? (heard.trim() ? V.sendNow : V.pause) : phase === 'paused' ? V.tapToTalk : V.thinking
  const busy = phase === 'sending' || phase === 'thinking'

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="full" motionPreset="slideInBottom">
      <ModalOverlay bg="page.bg" />
      <ModalContent bg="page.bg" boxShadow="none" m={0} aria-label={V.title} data-voice-mode={phase}>
        <Flex direction="column" h="100dvh" px={{ base: 5, md: 10 }} pt="calc(16px + env(safe-area-inset-top, 0px))" pb="calc(24px + env(safe-area-inset-bottom, 0px))">
          <Flex justify="space-between" align="center">
            <Text fontFamily={MONO} fontSize="11px" letterSpacing="0.12em" textTransform="uppercase" color="page.fg-secondary">
              {V.title}
            </Text>
            <IconButton aria-label={V.close} icon={<FiX aria-hidden />} variant="ghost" onClick={onClose} borderRadius="full" minW="44px" h="44px" />
          </Flex>

          <Flex flex="1" direction="column" align="center" justify="center" gap={8} minH={0}>
            <Box position="relative" w={{ base: '180px', md: '220px' }} h={{ base: '180px', md: '220px' }}>
              {phase === 'listening' ? (
                <>
                  <Box position="absolute" inset={0} borderRadius="full" border="2px solid" borderColor="accent.500" animation={`${ripple} 2s ease-out infinite`} aria-hidden />
                  <Box position="absolute" inset={0} borderRadius="full" border="2px solid" borderColor="accent.500" animation={`${ripple} 2s ease-out 1s infinite`} aria-hidden />
                </>
              ) : null}
              {phase === 'thinking' || phase === 'sending' ? (
                <Box position="absolute" inset="-10px" borderRadius="full" border="2px solid transparent" borderTopColor="accent.500" borderRightColor="accent.500" animation={`${spin} 1.1s linear infinite`} aria-hidden />
              ) : null}
              <Button
                variant="unstyled"
                position="absolute"
                inset={0}
                h="100%"
                w="100%"
                borderRadius="full"
                onClick={tap}
                aria-label={tapLabel}
                isDisabled={busy || !!blockedReason}
                _disabled={{ cursor: 'default' }}
                bgGradient={active ? 'radial(circle at 35% 30%, #a5b4fc, #6366f1 45%, #3730a3)' : 'radial(circle at 35% 30%, #d4d4d8, #737373 50%, #262626)'}
                boxShadow={active ? '0 30px 80px -20px rgba(99,102,241,0.65)' : '0 30px 80px -30px rgba(0,0,0,0.45)'}
                animation={phase === 'speaking' || phase === 'listening' ? `${breathe} ${phase === 'speaking' ? '1.2s' : '2.4s'} ease-in-out infinite` : undefined}
                transition="background 300ms ease, box-shadow 300ms ease"
                _focusVisible={{ outline: '3px solid', outlineColor: 'accent.500', outlineOffset: '6px' }}
                data-testid="voice-orb"
              />
            </Box>

            <Box textAlign="center" maxW="640px" minH="96px" w="100%">
              <Text fontSize={{ base: 'lg', md: 'xl' }} fontWeight={600} letterSpacing="-0.01em" role="status" aria-live="polite">
                {line}
              </Text>
              <Text mt={3} fontSize={{ base: 'md', md: 'lg' }} color="page.fg-secondary" noOfLines={3} lang={lang}>
                {phase === 'listening' ? `${heard}${heard && dictation.interim ? ' ' : ''}${dictation.interim}` : phase === 'sending' || phase === 'thinking' ? said : ''}
              </Text>
              {phase !== 'paused' && notice ? (
                <Text mt={3} fontSize="sm" color="page.fg-secondary">
                  {notice}
                </Text>
              ) : null}
              {waitingApproval ? (
                <Text mt={3} fontSize="sm" color="status.warning">
                  {V.approval}
                </Text>
              ) : null}
            </Box>
          </Flex>

          <Flex direction="column" align="center" gap={4}>
            <Flex gap={3} align="center">
              <IconButton
                aria-label={tapLabel}
                icon={phase === 'paused' ? <FiMic aria-hidden /> : <FiMicOff aria-hidden />}
                borderRadius="full"
                minW="52px"
                h="52px"
                variant="outline"
                borderColor="page.border-strong"
                onClick={tap}
                isDisabled={!!blockedReason || phase === 'sending' || phase === 'thinking'}
              />
              <Button borderRadius="full" h="52px" px={6} variant="outline" borderColor="status.error" color="status.error" _hover={{ bg: 'page.hover' }} onClick={onClose}>
                {V.close}
              </Button>
            </Flex>
            <Flex as="label" align="center" gap={2} fontSize="sm" color="page.fg-secondary" cursor="pointer">
              <Switch size="sm" isChecked={autoRead} onChange={(e) => setAutoRead(e.target.checked)} isDisabled={!speech.supported} colorScheme="accent" />
              {V.autoRead}
            </Flex>
            <Text fontSize="xs" color="page.fg-secondary" textAlign="center" maxW="420px">
              {V.tip}
            </Text>
          </Flex>
        </Flex>
        <VisuallyHidden>{V.tip}</VisuallyHidden>
      </ModalContent>
    </Modal>
  )
}
