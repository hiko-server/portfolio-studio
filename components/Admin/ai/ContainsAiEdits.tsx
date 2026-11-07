import NextLink from 'next/link'
import { Box, Link, Text } from '@chakra-ui/react'
import { MONO } from '../shell/ui'
import { ASK_COPY } from './askCopy'
import type { AiTouch } from './useAiTouch'

const C = ASK_COPY.contains

/**
 * "Contains AI edits" in the publish sheet and the schedule dialog (design
 * §4.6, §8.2): what is about to go live, or be scheduled to, came from AI —
 * with a link to that change. Information, never a block: the owner
 * publishes AI-written text knowingly.
 */
export default function ContainsAiEdits({ touch }: { touch: (AiTouch & { local: boolean }) | null }) {
  if (!touch) return null
  return (
    <Box borderLeft="2px solid" borderColor="accent.500" pl={3} py={0.5} data-testid="contains-ai-edits" data-change-id={touch.id}>
      <Text fontFamily={MONO} fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="accent.text">
        {C.title}
      </Text>
      <Text fontSize="sm" mt={0.5}>
        {touch.local ? C.local : C.saved}{' '}
        <Link as={NextLink} href={`/admin/ai/change/${touch.id}`} color="accent.text" textDecoration="underline" textUnderlineOffset="2px" target="_blank" rel="noopener">
          {C.open}
        </Link>
      </Text>
    </Box>
  )
}
