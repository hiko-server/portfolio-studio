import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Skeleton, Text } from '@chakra-ui/react'
import { outlineButtonProps } from '../shell/ui'
import { readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import ChangeCard from './ChangeCard'
import { ASSISTANT_COPY } from './copy'
import type { ChangeDetail, ChangeState } from './types'

/**
 * A change the assistant made or proposed, in the conversation (design §8.2):
 * the same card as Changes and the review page, loaded from
 * GET /api/admin/ai/changes/<id>, so everything on it is the server's. It
 * never takes the focus when it appears (the status line offers Review);
 * the wrapper can be focused when the owner asks for it.
 */
const ChatChange = forwardRef<HTMLDivElement, {
  id: string
  onState?: (id: string, state: ChangeState, title: string) => void
  onAskAgain?: () => void
  onUnauthorized: () => void
  /** Bumped when a run ends: the card reads its state again (a Stop, AI access turned off, a decision elsewhere). */
  epoch?: number
}>(function ChatChange({ id, onState, onAskAgain, onUnauthorized, epoch = 0 }, ref) {
  const [change, setChange] = useState<ChangeDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stateRef = useRef(onState)
  stateRef.current = onState

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/ai/changes/${encodeURIComponent(id)}`, { cache: 'no-store', credentials: 'same-origin' })
      if (res.status === 401) return onUnauthorized()
      if (!res.ok) {
        const json = await readJsonObject(res)
        setError(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
        return
      }
      const detail = (await res.json()) as ChangeDetail
      setError(null)
      setChange(detail)
      stateRef.current?.(id, detail.state, detail.title)
    } catch {
      setError(NETWORK_ERROR)
    }
  }, [id, onUnauthorized])

  useEffect(() => {
    void load()
  }, [load, epoch])

  if (error && !change) {
    return (
      <Flex ref={ref} tabIndex={-1} align="center" gap={3} flexWrap="wrap" border="1px solid" borderColor="page.border" borderRadius="xl" px={4} py={3} data-chat-change={id}>
        <Text fontSize="sm" color="page.fg-secondary" flex="1 1 200px">
          {ASSISTANT_COPY.change.error(error)}
        </Text>
        <Button size="xs" {...outlineButtonProps} onClick={() => void load()} minH={{ base: '44px', md: '24px' }}>
          {ASSISTANT_COPY.retry}
        </Button>
      </Flex>
    )
  }
  if (!change) {
    return (
      <Box ref={ref} tabIndex={-1} aria-busy="true" aria-label={ASSISTANT_COPY.change.loading} data-chat-change={id}>
        <Skeleton h="96px" borderRadius="xl" />
      </Box>
    )
  }
  return (
    <Box ref={ref} tabIndex={-1} borderRadius="xl" _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500', outlineOffset: '2px' }} data-chat-change={id}>
      <ChangeCard
        change={change}
        variant="panel"
        reload={load}
        onDecided={(state) => stateRef.current?.(id, state, change.title)}
        onAskAgain={change.actor.kind === 'assistant' ? onAskAgain : undefined}
      />
    </Box>
  )
})

export default ChatChange
