import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Skeleton, Text } from '@chakra-ui/react'
import { outlineButtonProps } from '../shell/ui'
import { readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import ChangeCard from './ChangeCard'
import EditorSuggestion from './EditorSuggestion'
import { ASSISTANT_COPY } from './copy'
import { ASK_COPY } from './askCopy'
import { usePanelHost } from './askContext'
import { sameTarget } from './editorBridge'
import type { ChangeDetail, ChangeState } from './types'

/**
 * A change the assistant made or proposed, in the conversation (design §8.2):
 * the same card as Changes and the review page, loaded from
 * GET /api/admin/ai/changes/<id>, so everything on it is the server's. It
 * never takes the focus when it appears (the status line offers Review);
 * the wrapper can be focused when the owner asks for it.
 *
 * In the Ask AI panel of an editor (§7.8): a change that editor can take —
 * a suggestion sent to it, or a post or page edit for its document — is the
 * editor's own card (EditorSuggestion: diff first, Apply to editor). A
 * proposal for the document an editor holds unsaved edits of waits: "Save
 * or discard your edits first".
 */
const ChatChange = forwardRef<HTMLDivElement, {
  id: string
  onState?: (id: string, state: ChangeState, title: string) => void
  onAskAgain?: () => void
  onUnauthorized: () => void
  /** Bumped when a run ends: the card reads its state again (a Stop, AI access turned off, a decision elsewhere). */
  epoch?: number
}>(function ChatChange({ id, onState, onAskAgain, onUnauthorized, epoch = 0 }, ref) {
  const host = usePanelHost()
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
  // The editor's own card while it can take the change, and for a suggestion it took (sent here, saved here).
  const forEditor =
    !!host.editor &&
    sameTarget(host.editor.target, change.target) &&
    (!!change.editor || change.kind === 'item.editor' || change.kind === 'page.editor' || change.result?.savedInEditor === true)
  // Unsaved edits of the document a proposal changes: approving now would be overwritten by the next save.
  const hostDirty =
    (host.editor && host.editor.dirty && sameTarget(host.editor.target, change.target)) ||
    (host.doc && host.doc.dirty && host.doc.target.kind === change.target.kind)
  return (
    <Box ref={ref} tabIndex={-1} borderRadius="xl" _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500', outlineOffset: '2px' }} data-chat-change={id}>
      {forEditor && host.editor ? (
        <EditorSuggestion
          change={change}
          reload={load}
          editor={host.editor}
          onDecided={(state) => stateRef.current?.(id, state, change.title)}
          onAskAgain={change.actor.kind === 'assistant' ? onAskAgain : undefined}
        />
      ) : (
        <ChangeCard
          change={change}
          variant="panel"
          reload={load}
          onDecided={(state) => stateRef.current?.(id, state, change.title)}
          onAskAgain={change.actor.kind === 'assistant' ? onAskAgain : undefined}
          blockedBy={hostDirty ? ASK_COPY.saveOrDiscard : null}
        />
      )}
    </Box>
  )
})

export default ChatChange
