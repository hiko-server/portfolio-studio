import { useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Text } from '@chakra-ui/react'
import { MONO, outlineButtonProps } from '../shell/ui'
import { AI_COPY } from './copy'

/**
 * A value to copy (an address, a token, a command): mono, wrapping anywhere
 * so a long token never widens the page on a phone, with its own Copy button.
 * The copied state lasts a few seconds and is announced once, politely.
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
  const timer = useRef<number | null>(null)
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 4000)
    } catch {
      setCopied(false)
    }
  }

  return (
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
      <Box role="status" aria-live="polite" srOnly>
        {copied ? (announce ?? AI_COPY.copiedAnnouncement(label)) : ''}
      </Box>
    </Flex>
  )
}
