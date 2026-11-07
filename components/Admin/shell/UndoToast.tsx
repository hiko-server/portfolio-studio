import { useSyncExternalStore } from 'react'
import { Button, Text } from '@chakra-ui/react'
import InverseToast from '../cvStudio/InverseToast'

/** How long an "… · Undo" toast for the action just taken stays (an AI change just approved, design §8.2). */
export const UNDO_MS = 8000

/**
 * Toast with an Undo that reverts exactly one action — disabled once
 * anything else changed (extracted from CV Studio, where it reverts one
 * edit; design §8.2 uses it for an AI change just approved). `subscribe` and
 * `isCurrent` are a tiny external store: the button follows `isCurrent()`
 * live, so an Undo that no longer applies can't be pressed.
 */
export default function UndoToast({
  title,
  subscribe,
  isCurrent,
  onUndo,
  undoHint,
}: {
  title: string
  subscribe: (cb: () => void) => () => void
  isCurrent: () => boolean
  onUndo: () => void
  /** Why Undo is off, once it is (its title). */
  undoHint: string
}) {
  const canUndo = useSyncExternalStore(subscribe, isCurrent, () => false)
  return (
    <InverseToast>
      <Text>{title}</Text>
      <Button
        size="xs"
        variant="outline"
        color="inherit"
        borderColor="currentColor"
        _hover={{ bg: 'rgba(127,127,127,0.18)' }}
        isDisabled={!canUndo}
        title={canUndo ? undefined : undoHint}
        onClick={onUndo}
      >
        Undo
      </Button>
    </InverseToast>
  )
}
