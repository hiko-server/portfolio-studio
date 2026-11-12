import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, Button, Flex, IconButton, Menu, MenuButton, MenuDivider, MenuItem, MenuItemOption, MenuList, MenuOptionGroup, Text, Tooltip, VisuallyHidden } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { FiAtSign, FiCamera, FiChevronDown, FiMic, FiMonitor, FiPaperclip, FiPlus, FiRadio, FiSquare, FiTrash2, FiUpload } from 'react-icons/fi'
import { MONO } from '../../shell/ui'
import { MEDIA_COPY } from './copy'
import { formatDuration } from './prepare'

const A = MEDIA_COPY.attach
const D = MEDIA_COPY.dictation

const ACCEPT = 'image/*,application/pdf,audio/*,text/*,.md,.mdx,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.svg,.html,.css,.js,.mjs,.cjs,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.cs,.php,.sql,.sh,.log,.txt,.srt,.vtt,.diff,.patch'

const pulse = keyframes`0% { box-shadow: 0 0 0 0 rgba(99,102,241,0.55); } 70% { box-shadow: 0 0 0 9px rgba(99,102,241,0); } 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); }`

const toolButton = {
  size: 'sm' as const,
  variant: 'ghost' as const,
  color: 'page.fg-secondary',
  _hover: { color: 'page.fg', bg: 'page.hover' },
  _active: { bg: 'page.bg-overlay' },
  minW: { base: '44px', md: '32px' },
  h: { base: '44px', md: '32px' },
  borderRadius: 'lg',
}

function MenuRow({ icon, label, hint }: { icon: ReactNode; label: string; hint: string }) {
  return (
    <Flex align="center" gap={3} py={0.5}>
      <Flex w="28px" h="28px" align="center" justify="center" borderRadius="md" border="1px solid" borderColor="page.border" bg="page.bg-elevated" color="page.fg" flexShrink={0} aria-hidden>
        {icon}
      </Flex>
      <Box>
        <Text fontSize="13px" fontWeight={500} lineHeight="1.3">
          {label}
        </Text>
        <Text fontSize="11px" color="page.fg-secondary" lineHeight="1.3">
          {hint}
        </Text>
      </Box>
    </Flex>
  )
}

/**
 * + in the message box: files and photos (the file picker; on a phone the
 * picker offers the camera too), a photo from this device's camera, a
 * capture of the screen, a voice message, and the site's own content (the
 * context picker). Each item shows only where this browser can do it.
 */
export function AttachMenu({
  onFiles,
  onCamera,
  onScreen,
  onRecord,
  onContext,
  disabled,
  canCamera,
  canScreen,
  canRecord,
}: {
  onFiles: (files: File[]) => void
  onCamera: () => void
  onScreen: () => void
  onRecord: () => void
  onContext?: () => void
  disabled?: boolean
  canCamera: boolean
  canScreen: boolean
  canRecord: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const [touch, setTouch] = useState(false)
  useEffect(() => {
    try {
      setTouch(window.matchMedia('(hover: none) and (pointer: coarse)').matches)
    } catch {
      setTouch(false)
    }
  }, [])
  const take = (list: FileList | null) => {
    if (list?.length) onFiles(Array.from(list))
  }
  return (
    <>
      <Menu placement="top-start" isLazy>
        <Tooltip label={A.button} openDelay={500} hasArrow>
          <MenuButton as={IconButton} aria-label={A.menu} icon={<FiPlus aria-hidden />} {...toolButton} isDisabled={disabled} data-testid="composer-attach" />
        </Tooltip>
        <MenuList bg="page.bg-elevated" borderColor="page.border" boxShadow="elevation.md" py={1.5} minW="250px" zIndex={20}>
          <MenuItem bg="transparent" _hover={{ bg: 'page.hover' }} _focus={{ bg: 'page.hover' }} onClick={() => input.current?.click()}>
            <MenuRow icon={<FiPaperclip />} label={A.files} hint={A.filesHint} />
          </MenuItem>
          {canCamera ? (
            <MenuItem bg="transparent" _hover={{ bg: 'page.hover' }} _focus={{ bg: 'page.hover' }} onClick={() => (touch ? cameraInput.current?.click() : onCamera())}>
              <MenuRow icon={<FiCamera />} label={A.camera} hint={A.cameraHint} />
            </MenuItem>
          ) : null}
          {canScreen ? (
            <MenuItem bg="transparent" _hover={{ bg: 'page.hover' }} _focus={{ bg: 'page.hover' }} onClick={onScreen}>
              <MenuRow icon={<FiMonitor />} label={A.screen} hint={A.screenHint} />
            </MenuItem>
          ) : null}
          {canRecord ? (
            <MenuItem bg="transparent" _hover={{ bg: 'page.hover' }} _focus={{ bg: 'page.hover' }} onClick={onRecord}>
              <MenuRow icon={<FiRadio />} label={A.record} hint={A.recordHint} />
            </MenuItem>
          ) : null}
          {onContext ? (
            <>
              <MenuDivider borderColor="page.border" />
              <MenuItem bg="transparent" _hover={{ bg: 'page.hover' }} _focus={{ bg: 'page.hover' }} onClick={onContext}>
                <MenuRow icon={<FiAtSign />} label={A.context} hint={A.contextHint} />
              </MenuItem>
            </>
          ) : null}
        </MenuList>
      </Menu>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          take(e.target.files)
          e.target.value = ''
        }}
        data-testid="composer-file-input"
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          take(e.target.files)
          e.target.value = ''
        }}
      />
    </>
  )
}

/** The microphone: dictation into the message box, with its language beside it. */
export function DictationControl({
  supported,
  listening,
  onToggle,
  lang,
  onLang,
  disabled,
}: {
  supported: boolean
  listening: boolean
  onToggle: () => void
  lang: string
  onLang: (lang: string) => void
  disabled?: boolean
}) {
  if (!supported) return null
  return (
    <Flex align="center" gap={0}>
      <Tooltip label={listening ? D.stop : `${D.start} · ${D.langs[lang] ?? lang}`} openDelay={500} hasArrow>
        <IconButton
          aria-label={listening ? D.stop : D.start}
          aria-pressed={listening}
          icon={listening ? <FiSquare aria-hidden /> : <FiMic aria-hidden />}
          {...toolButton}
          color={listening ? 'accent.fg' : toolButton.color}
          bg={listening ? 'accent.solid' : undefined}
          _hover={listening ? { bg: 'accent.solid-hover' } : toolButton._hover}
          animation={listening ? `${pulse} 1.6s ease-out infinite` : undefined}
          onClick={onToggle}
          isDisabled={disabled && !listening}
          data-testid="composer-dictate"
        />
      </Tooltip>
      <Menu placement="top-end" isLazy>
        <MenuButton as={IconButton} aria-label={D.language} icon={<FiChevronDown aria-hidden />} {...toolButton} minW={{ base: '28px', md: '18px' }} w={{ base: '28px', md: '18px' }} px={0} />
        <MenuList bg="page.bg-elevated" borderColor="page.border" boxShadow="elevation.md" zIndex={20} minW="200px">
          <MenuOptionGroup title={D.language} type="radio" value={lang} onChange={(v) => onLang(String(v))} fontSize="11px" fontFamily={MONO} color="page.fg-secondary">
            {Object.entries(D.langs).map(([code, label]) => (
              <MenuItemOption key={code} value={code} bg="transparent" _hover={{ bg: 'page.hover' }} _focus={{ bg: 'page.hover' }} fontSize="13px" lang={code}>
                {label}
              </MenuItemOption>
            ))}
          </MenuOptionGroup>
        </MenuList>
      </Menu>
    </Flex>
  )
}

/** The words being heard, and where they are heard (on this device, or the browser's speech service). */
export function DictationStrip({ interim, local }: { interim: string; local: boolean | null }) {
  return (
    <Flex align="center" gap={2} px={4} pt={2.5} minW={0} role="status" aria-live="polite" data-dictation="">
      <Box as="span" w="7px" h="7px" borderRadius="full" bg="status.error" flexShrink={0} animation={`${pulse} 1.6s ease-out infinite`} aria-hidden />
      <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" flexShrink={0}>
        {D.listening}
        {local !== null ? ` · ${local ? D.local : D.service}` : ''}
      </Text>
      <Text fontSize="13px" color="page.fg-secondary" fontStyle="italic" noOfLines={1} minW={0}>
        {interim}
      </Text>
    </Flex>
  )
}

/** A voice message being recorded: its time, a live level, Stop and attach, Discard. */
export function RecorderBar({ elapsed, level, onStop, onCancel }: { elapsed: number; level: number; onStop: () => void; onCancel: () => void }) {
  const bars = 24
  return (
    <Flex align="center" gap={3} px={3} py={2.5} borderBottom="1px solid" borderColor="page.border" data-recorder="">
      <Box as="span" w="9px" h="9px" borderRadius="full" bg="status.error" flexShrink={0} animation={`${pulse} 1.6s ease-out infinite`} aria-hidden />
      <Text fontFamily={MONO} fontSize="12px" sx={{ fontVariantNumeric: "tabular-nums" }} flexShrink={0} aria-live="off">
        {formatDuration(elapsed)}
      </Text>
      <Flex align="center" gap="2px" h="24px" flex="1" minW={0} overflow="hidden" aria-hidden>
        {Array.from({ length: bars }, (_, i) => {
          const wave = Math.sin((elapsed / 120 + i) * 0.9) * 0.5 + 0.5
          const h = Math.max(0.12, Math.min(1, level * (0.55 + wave * 0.45)))
          return <Box key={i} w="3px" flexShrink={0} borderRadius="full" bg="accent.500" h={`${Math.round(h * 100)}%`} transition="height 90ms linear" opacity={0.5 + h / 2} />
        })}
      </Flex>
      <VisuallyHidden>{MEDIA_COPY.recorder.title}</VisuallyHidden>
      <IconButton aria-label={MEDIA_COPY.recorder.cancel} icon={<FiTrash2 aria-hidden />} {...toolButton} onClick={onCancel} />
      <Button size="sm" leftIcon={<FiUpload aria-hidden />} onClick={onStop} bg="accent.solid" color="accent.fg" _hover={{ bg: 'accent.solid-hover' }} minH={{ base: '44px', md: '32px' }}>
        {MEDIA_COPY.recorder.stop}
      </Button>
    </Flex>
  )
}

/** The way into voice mode. */
export function VoiceModeButton({ onOpen, disabled, reason }: { onOpen: () => void; disabled?: boolean; reason?: string | null }) {
  return (
    <Tooltip label={disabled && reason ? reason : MEDIA_COPY.voice.openHint} openDelay={400} hasArrow>
      <IconButton aria-label={MEDIA_COPY.voice.open} icon={<WaveIcon />} {...toolButton} onClick={onOpen} isDisabled={disabled} data-testid="composer-voice" />
    </Tooltip>
  )
}

function WaveIcon() {
  return (
    <Box as="svg" viewBox="0 0 24 24" w="18px" h="18px" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
    </Box>
  )
}
