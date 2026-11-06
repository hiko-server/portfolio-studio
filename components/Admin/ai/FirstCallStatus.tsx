import { Box, Flex, Text } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { relativeTime } from '../security/securityFormat'
import { AI_COPY } from './copy'
import type { AppView } from './types'

const pulse = keyframes`
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
`

/**
 * The live confirmation of a new token (design §8.5): "Waiting for the first
 * call…" until the server records the app's first request (ai_grants
 * first_used_at, polled by the page every 5 seconds while it is visible),
 * then "Connected. First call just now." Real, never inferred: it changes
 * only when the server says so. One polite status; the dot pulses only
 * without reduced motion.
 */
export default function FirstCallStatus({ app, now }: { app: AppView; now: number }) {
  const connected = app.firstUsedAt !== null
  return (
    <Flex
      align="flex-start"
      gap={2.5}
      px={3}
      py={2.5}
      border="1px solid"
      borderColor="page.border"
      borderRadius="md"
      bg="page.bg"
      data-first-call={connected ? 'connected' : 'waiting'}
    >
      <Box
        as="span"
        aria-hidden
        flexShrink={0}
        mt="6px"
        w="8px"
        h="8px"
        borderRadius="full"
        bg={connected ? 'green.500' : 'accent.500'}
        sx={
          connected
            ? undefined
            : {
                animation: `${pulse} 1.6s ease-in-out infinite`,
                '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
              }
        }
      />
      <Text fontSize="sm" minW={0}>
        {/* Only the state is live, so a ticking "2 min. ago" is never read out again. */}
        <Box as="span" role="status" aria-live="polite" fontWeight={connected ? 600 : 400}>
          {connected ? AI_COPY.connect.connected : AI_COPY.connect.waiting(app.name)}
        </Box>
        {connected ? (
          <Box as="span" color="page.fg-secondary">
            {' '}
            {AI_COPY.connect.firstCall(relativeTime(app.firstUsedAt as number, Math.max(now, app.firstUsedAt as number)))}
            {app.clientReported ? AI_COPY.connect.saysItIs(app.clientReported) : ''}
          </Box>
        ) : null}
      </Text>
    </Flex>
  )
}
