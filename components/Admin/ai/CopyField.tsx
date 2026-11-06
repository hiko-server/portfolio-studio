import { useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Text } from '@chakra-ui/react'
import { MONO, outlineButtonProps } from '../shell/ui'
import { copyText } from '../../MDX/clipboard'
import { AI_COPY } from './copy'

/**
 * A value to copy (an address, a token, a command): mono, wrapping anywhere
 * so a long token never widens the page on a phone, with its own Copy button.
 * The copied state lasts a few seconds and is announced once, politely.
 * When the browser refuses the clipboard (no permission, a page that is not a
 * secure context and no fallback), the value's text is selected and a line
 * under it says to copy it by hand: a token shown once is never lost to a
 * copy that silently did nothing.
 */
export default function CopyField({
  label,
  value,
  copyLabel = AI_COPY.copy,
  announce,
  emphasis = false,
  id,
}: {
  /** What it is, for the button's accessible name and the announcement. */
  label: string
  value: string
  copyLabel?: string
  /** Words read after copying (default: "<label> copied to the clipboard."). */
  announce?: string
  /** A secret shown once: a stronger edge so it reads as the thing to take. */
  emphasis?: boolean
  id?: string
}) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<number | null>(null)
  const valueRef = useRef<HTMLElement>(null)
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  /** Select the value's text, so copying it by hand is one keystroke or one tap away. */
  const selectValue = () => {
    const el = valueRef.current
    const selection = typeof window !== 'undefined' ? window.getSelection() : null
    if (!el || !selection) return
    const range = document.createRange()
    range.selectNodeContents(el)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  const copy = async () => {
    if (timer.current) window.clearTimeout(timer.current)
    if (await copyText(value)) {
      setFailed(false)
      setCopied(true)
      timer.current = window.setTimeout(() => setCopied(false), 4000)
      return
    }
    setCopied(false)
    setFailed(true)
    selectValue()
  }

  return (
    <Box minW={0}>
      <Flex
        align={{ base: 'stretch', sm: 'center' }}
        direction={{ base: 'column', sm: 'row' }}
        gap={2}
        p={2}
        pl={3}
        border="1px solid"
        borderColor={emphasis ? 'page.border-strong' : 'page.border'}
        borderRadius="md"
        bg="page.bg"
        minW={0}
      >
        <Text
          ref={valueRef}
          id={id}
          as="code"
          flex="1 1 auto"
          minW={0}
          fontFamily={MONO}
          fontSize="12.5px"
          lineHeight="1.6"
          color="page.fg"
          overflowWrap="anywhere"
          whiteSpace="pre-wrap"
          className="tnum"
        >
          {value}
        </Text>
        <Button
          size="xs"
          {...outlineButtonProps}
          flexShrink={0}
          alignSelf={{ base: 'flex-start', sm: 'center' }}
          onClick={() => void copy()}
        >
          {copied ? AI_COPY.copied : copyLabel}
          <Box as="span" srOnly>
            {` (${label})`}
          </Box>
        </Button>
      </Flex>
      {/* One polite region: read once after copying; seen as well when copying failed. */}
      <Text role="status" aria-live="polite" srOnly={failed ? undefined : true} mt={failed ? 1.5 : 0} fontSize="xs" color="status.warning">
        {failed ? AI_COPY.copyFailed : copied ? (announce ?? AI_COPY.copiedAnnouncement(label)) : ''}
      </Text>
    </Box>
  )
}
