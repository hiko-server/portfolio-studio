import { useId, useState } from 'react'
import { Box, Button, Flex, Text } from '@chakra-ui/react'
import { MONO, SavingDots } from '../shell/ui'
import { ASSISTANT_COPY } from './copy'

/**
 * One tool call in the conversation (PRODUCT §4.2): a mono line titled from
 * the server's catalogue — never from model text — that opens to what was
 * sent and what came back, both as plain text. Running: the title with
 * dots (static under reduced motion). A failure names its code in the error
 * colour. A button with aria-expanded; nothing in it is ever markup or a link.
 */
export default function ToolRow({
  name,
  title,
  state,
  code,
  args,
  result,
}: {
  name: string
  /** The catalogue's title (the server put it on the event); the tool's name when it has none. */
  title: string | null
  state: 'running' | 'ok' | 'error'
  code?: string | null
  args?: string | null
  result?: string | null
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const label = title || name
  const expandable = state !== 'running' && (args != null || result != null)
  const t = ASSISTANT_COPY.tool
  const failure = state === 'error' ? (code === 'CANCELLED' || code === 'BUDGET' ? t.cancelled : t.failed(code || 'ERROR')) : null

  const line = (
    <Flex as="span" align="baseline" gap={2} minW={0} w="100%">
      <Box as="span" aria-hidden color="page.fg-subtle" w="10px" flexShrink={0} transform={open ? 'rotate(90deg)' : undefined} transition="transform 120ms ease" display="inline-block">
        {expandable ? '▸' : '·'}
      </Box>
      <Text as="span" noOfLines={1} minW={0} color={state === 'error' ? 'page.fg-secondary' : 'page.fg'}>
        {state === 'running' ? (
          <>
            {label}
            <SavingDots />
          </>
        ) : (
          label
        )}
      </Text>
      {failure ? (
        <Text as="span" flexShrink={0} color="status.error" fontSize="11px">
          {failure}
        </Text>
      ) : null}
      <Text as="span" ml="auto" flexShrink={0} color="page.fg-subtle" fontSize="10px" display={{ base: 'none', sm: 'inline' }}>
        {name}
      </Text>
    </Flex>
  )

  return (
    <Box fontFamily={MONO} fontSize="12px" data-tool-row={state}>
      {expandable ? (
        <Button
          variant="unstyled"
          display="flex"
          w="100%"
          h="auto"
          minH="28px"
          py={1}
          px={2}
          mx={-2}
          textAlign="left"
          fontFamily={MONO}
          fontSize="12px"
          fontWeight={400}
          borderRadius="md"
          _hover={{ bg: 'page.bg-overlay' }}
          _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500', outlineOffset: '1px' }}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
        >
          {line}
        </Button>
      ) : (
        <Box py={1} minH="28px" display="flex" alignItems="center">
          {line}
        </Box>
      )}
      {expandable ? (
        <Box id={id} hidden={!open} ml={4} mt={1} mb={2} pl={3} borderLeft="1px solid" borderColor="page.border">
          <Text fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="page.fg-secondary">
            {t.args}
          </Text>
          <Box as="pre" mt={1} whiteSpace="pre-wrap" wordBreak="break-word" color="page.fg-secondary" fontSize="11.5px">
            {args && args !== '{}' ? args : t.noArgs}
          </Box>
          {result != null ? (
            <>
              <Text mt={2} fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="page.fg-secondary">
                {t.result}
              </Text>
              <Box as="pre" mt={1} whiteSpace="pre-wrap" wordBreak="break-word" color="page.fg-secondary" fontSize="11.5px" maxH="320px" overflowY="auto" tabIndex={0} aria-label={`${t.result}: ${label}`} _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500' }}>
                {result}
              </Box>
            </>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}
