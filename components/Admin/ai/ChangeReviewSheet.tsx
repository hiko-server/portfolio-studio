import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import dynamic from 'next/dynamic'
import {
  Box,
  Button,
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  Flex,
  Heading,
  Spinner,
  Stack,
  Text,
  useBreakpointValue,
} from '@chakra-ui/react'
import SegmentedTabs, { tabPanelProps, type SegmentedItem } from '../shell/SegmentedTabs'
import { Eyebrow, MONO, outlineButtonProps, primaryButtonProps } from '../shell/ui'
import { CHANGES_COPY } from './copy'
import { actorText, titleParts, type ChangeDiff } from './changeFormat'
import { DocHeader, JsonDiffRows, MdxDiff, lineCounts } from './ChangeDiffView'
import { useArmedAction } from './useArmedAction'
import type { ChangeDetail } from './types'

type Tab = 'changes' | 'preview'

// The site's article renderer loads with the Preview tab, not with the Changes view.
const ChangePreviewPane = dynamic(() => import('./ChangePreviewPane'), {
  ssr: false,
  loading: function PreviewLoading() {
    return (
      <Flex h="160px" align="center" justify="center" role="status" aria-label={CHANGES_COPY.sheet.previewLoading}>
        <Spinner color="accent.500" />
      </Flex>
    )
  },
})

export type SheetApprove = {
  label: string
  destructive: boolean
  busy: boolean
  /** Another decision is running. */
  blocked: boolean
  /** The whole change has been shown to its end (this sheet's own observer said so). */
  read: boolean
  onApprove: () => void
  onReject: () => void
}

/**
 * The whole of an AI change (design §5.3, §8.2), placed like PublishSheet:
 * a bottom sheet on phones, a drawer on the right from md. `Changes` lists
 * every document in full (nothing shortened); an IntersectionObserver on the
 * line after the last one tells the card the change has been read to its
 * end, which is what lets a long change be approved. `Preview` renders an
 * MDX document with the site's renderer from a worker-compiled tree in which
 * images from other sites, players and links are replaced, so nothing loads.
 * Approve and Reject stay in the footer; Approve is armed here as on the card.
 */
export default function ChangeReviewSheet({
  isOpen,
  onClose,
  finalFocusRef,
  change,
  diff,
  onReadToEnd,
  approve,
}: {
  isOpen: boolean
  onClose: () => void
  finalFocusRef?: RefObject<HTMLElement | null>
  change: ChangeDetail
  diff: ChangeDiff
  onReadToEnd: () => void
  /** Null once the change is decided: the sheet is the record then. */
  approve: SheetApprove | null
}) {
  const placement = useBreakpointValue<'bottom' | 'right'>({ base: 'bottom', md: 'right' }, { ssr: false }) ?? 'right'
  const [tab, setTab] = useState<Tab>('changes')
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const { ref: armRef, armed } = useArmedAction<HTMLElement>(isOpen && !!approve)
  const previewDocs = useMemo(() => (change.preview?.documents ?? []).map((d, i) => ({ d, i })).filter(({ d }) => d.format === 'mdx' && d.after), [change.preview])
  const [pre, ref, post] = titleParts(change.title, change.target)
  const read = approve?.read ?? false

  useEffect(() => {
    if (isOpen) setTab('changes')
  }, [isOpen])

  // Read to the end: the line after the last document has been on screen inside the sheet's scrolling body.
  useEffect(() => {
    const end = endRef.current
    if (!isOpen || tab !== 'changes' || !body || !end || read) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onReadToEnd()
      },
      { root: body, threshold: 0 },
    )
    io.observe(end)
    return () => io.disconnect()
  }, [isOpen, tab, body, read, onReadToEnd])

  const tabs: SegmentedItem<Tab>[] = [
    { key: 'changes', label: CHANGES_COPY.sheet.changes },
    ...(previewDocs.length ? [{ key: 'preview' as const, label: CHANGES_COPY.sheet.preview }] : []),
  ]
  const unit = CHANGES_COPY.unit(diff.changed, diff.unit)

  return (
    <Drawer isOpen={isOpen} onClose={onClose} placement={placement} size={placement === 'right' ? 'lg' : 'full'} finalFocusRef={finalFocusRef as RefObject<HTMLElement> | undefined}>
      <DrawerOverlay />
      <DrawerContent
        ref={armRef}
        bg="page.bg-elevated"
        borderColor="page.border"
        borderLeft={placement === 'right' ? '1px solid' : undefined}
        borderTop={placement === 'bottom' ? '1px solid' : undefined}
        borderTopRadius={placement === 'bottom' ? 'xl' : undefined}
        maxH={placement === 'bottom' ? '92dvh' : undefined}
        data-testid="change-sheet"
      >
        <DrawerCloseButton aria-label={CHANGES_COPY.sheet.close} />
        <DrawerHeader pb={3} pr={12} borderBottom="1px solid" borderColor="page.border">
          <Eyebrow accent>{CHANGES_COPY.sheet.eyebrow}</Eyebrow>
          <Heading as="h2" fontSize="md" fontWeight={600} mt={1} letterSpacing="-0.01em" wordBreak="break-word">
            {pre}
            {ref ? (
              <Text as="span" fontFamily={MONO} fontSize="0.92em" fontWeight={500}>
                {ref}
              </Text>
            ) : null}
            {post}
          </Heading>
          <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" mt={1} fontWeight={400} className="tnum">
            {actorText(change.actor)} · {CHANGES_COPY.documents(diff.docs.length)} · {diff.changed.toLocaleString('en')} changed {unit}
          </Text>
          {tabs.length > 1 ? (
            <Box mt={3} display="inline-flex" maxW="100%">
              <SegmentedTabs items={tabs} value={tab} onSelect={setTab} label={CHANGES_COPY.sheet.tabsLabel} idPrefix={`sheet-${change.id}`} size="sm" />
            </Box>
          ) : null}
        </DrawerHeader>
        {/* The body is the scroll region: focusable, so the keyboard can read the change to its end (Page Down, End). */}
        <DrawerBody ref={setBody} py={4} tabIndex={0} aria-label={CHANGES_COPY.sheet.bodyLabel} _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500', outlineOffset: '-2px' }}>
          <Box {...(tabs.length > 1 ? tabPanelProps(`sheet-${change.id}`, tab) : {})}>
            {tab === 'changes' ? (
              <Stack spacing={5}>
                {diff.docs.map((d) => (
                  <Box key={d.doc.ref} as="section" aria-label={d.doc.label}>
                    <DocHeader doc={d.doc} counts={d.format === 'mdx' ? lineCounts(d.lines) : null} />
                    {d.format === 'mdx' ? <MdxDiff lines={d.lines} context={3} /> : <JsonDiffRows entries={d.entries} />}
                  </Box>
                ))}
                <Flex ref={endRef} align="center" gap={3} color="page.fg-subtle" fontFamily={MONO} fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" pt={1} pb={2} data-testid="change-end">
                  <Box flex={1} h="1px" bg="page.border" />
                  {CHANGES_COPY.sheet.end}
                  <Box flex={1} h="1px" bg="page.border" />
                </Flex>
              </Stack>
            ) : (
              <ChangePreviewPane changeId={change.id} docs={previewDocs} />
            )}
          </Box>
        </DrawerBody>
        {approve ? (
          <DrawerFooter gap={2} borderTop="1px solid" borderColor="page.border" flexDirection="column" alignItems="stretch">
            <Text fontSize="xs" color="page.fg-secondary" role="status" aria-live="polite" mb={1}>
              {read ? CHANGES_COPY.sheet.readDone : CHANGES_COPY.sheet.readProgress}
            </Text>
            <Flex gap={2} flexDirection={{ base: 'column-reverse', sm: 'row' }} justify="flex-end">
              <Button size="sm" {...outlineButtonProps} onClick={approve.onReject} isDisabled={approve.busy || approve.blocked} minH={{ base: '44px', sm: 'auto' }}>
                {CHANGES_COPY.reject}
              </Button>
              <Button
                size="sm"
                {...(approve.destructive ? { colorScheme: 'red' } : primaryButtonProps)}
                isDisabled={!read || !armed || approve.blocked}
                isLoading={approve.busy}
                loadingText={CHANGES_COPY.approving}
                onClick={() => {
                  if (read && armed) approve.onApprove()
                }}
                minH={{ base: '44px', sm: 'auto' }}
                whiteSpace="normal"
                data-testid="sheet-approve"
                data-armed={armed ? 'true' : 'false'}
              >
                {read ? approve.label : CHANGES_COPY.readFirst(diff.changed, unit)}
              </Button>
            </Flex>
          </DrawerFooter>
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}
