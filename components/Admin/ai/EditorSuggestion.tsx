import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Flex, Heading, Stack, Text, useToast } from '@chakra-ui/react'
import { MONO, outlineButtonProps, primaryButtonProps } from '../shell/ui'
import { loginHref, readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { ASK_COPY } from './askCopy'
import { CHANGES_COPY, LINK_FLAG_COPY } from './copy'
import { actorText, changeDiff, compactDiff, titleParts } from './changeFormat'
import { DocHeader, MdxDiff } from './ChangeDiffView'
import ChangeReviewSheet from './ChangeReviewSheet'
import { ChangeStateChip, When } from './ChangeCard'
import { applied, canApply, sameDoc, targetNoun, type EditorDoc } from './editorBridge'
import type { EditorHost } from './askContext'
import type { ChangeDetail, ChangeState } from './types'

const S = ASK_COPY.suggestion

/**
 * An AI change for the editor it is shown in (design §7.8, §8.2 Open in
 * editor): a suggestion the assistant sent to this open editor, or a
 * waiting post or page edit the owner brought here from Changes.
 *
 * The diff and the new links come first, then "Apply to editor" and
 * "Dismiss". Apply reads the change again (still open? its payload), checks
 * that the editor still holds the exact text the change was computed from
 * (the base hash) and only then replaces the body and sets the change's
 * fields — whole text or nothing: "The post changed while this was being
 * written. Ask again." Nothing is written to the site: the editor goes
 * dirty and is AI-touched until the owner saves, and that save is
 * attributed (POST editor-saved). Undo puts the previous text back while
 * the editor still holds exactly what Apply put there. Dismiss rejects a
 * suggestion; a proposal from Changes only leaves this panel and keeps
 * waiting there.
 */
export default function EditorSuggestion({
  change,
  reload,
  editor,
  onAskAgain,
  onDecided,
}: {
  change: ChangeDetail
  reload: () => Promise<void>
  editor: EditorHost
  onAskAgain?: () => void
  onDecided?: (state: ChangeState) => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState<'apply' | 'dismiss' | 'undo' | null>(null)
  const [phase, setPhase] = useState<'idle' | 'applied' | 'changed' | 'hidden'>(() => (editor.touched.includes(change.id) ? 'applied' : 'idle'))
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetMounted, setSheetMounted] = useState(false)
  const [editedSince, setEditedSince] = useState(false)
  const before = useRef<{ prev: EditorDoc; next: EditorDoc } | null>(null)
  const reviewRef = useRef<HTMLButtonElement>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  useEffect(() => {
    if (sheetOpen) setSheetMounted(true)
  }, [sheetOpen])

  // Saved in the editor (its touched mark went with the save): read the change again — it is applied now.
  const touched = editor.touched.includes(change.id)
  const wasTouched = useRef(touched)
  useEffect(() => {
    if (wasTouched.current && !touched && phase === 'applied') {
      before.current = null
      setPhase('idle')
      void reload()
    }
    wasTouched.current = touched
  }, [touched, phase, reload])

  const preview = change.preview
  const diff = useMemo(() => (preview ? changeDiff(preview) : null), [preview])
  const compact = useMemo(() => (diff ? compactDiff(diff) : null), [diff])
  const noun = targetNoun(editor.target)
  const fromChanges = change.state === 'waiting'
  const open = change.state === 'in_editor' || change.state === 'waiting'
  const headingId = `suggestion-${change.id}-title`
  const [pre, mono, post] = titleParts(change.title, change.target)

  const toLogin = () => {
    window.location.href = loginHref(`${window.location.pathname}${window.location.search}`)
  }

  const apply = async () => {
    if (busy) return
    if (editor.saving) {
      toast({ status: 'info', title: S.saving, duration: 4000 })
      return
    }
    setBusy('apply')
    try {
      // The change as the server holds it now: still open, and the exact payload to apply.
      const res = await fetch(`/api/admin/ai/changes/${change.id}`, { cache: 'no-store', credentials: 'same-origin' })
      if (res.status === 401) return toLogin()
      if (!res.ok) {
        const json = await readJsonObject(res)
        toast({ status: 'error', title: S.apply, description: typeof json.error === 'string' ? json.error : `HTTP ${res.status}`, duration: 6000, isClosable: true })
        return
      }
      const fresh = (await res.json()) as ChangeDetail
      if (!fresh.editor || (fresh.state !== 'in_editor' && fresh.state !== 'waiting')) {
        await reload()
        return
      }
      const doc = editor.current()
      if (!(await canApply(doc, fresh.editor))) {
        setPhase('changed')
        return
      }
      const next = applied(doc, fresh.editor)
      before.current = { prev: doc, next }
      editor.replace(next)
      editor.markTouched(change.id)
      setEditedSince(false)
      setPhase('applied')
    } catch {
      toast({ status: 'error', title: S.apply, description: NETWORK_ERROR, duration: 6000, isClosable: true })
    } finally {
      setBusy(null)
    }
  }

  const undo = async () => {
    const kept = before.current
    if (!kept || busy) return
    setBusy('undo')
    try {
      if (!(await sameDoc(editor.current(), kept.next))) {
        setEditedSince(true)
        return
      }
      editor.replace(kept.prev)
      editor.unmarkTouched(change.id)
      before.current = null
      setPhase('idle')
    } finally {
      setBusy(null)
    }
  }

  const dismiss = async () => {
    if (busy) return
    // A proposal from Changes only leaves this panel: it still waits there for a decision.
    if (fromChanges) {
      setPhase('hidden')
      return
    }
    setBusy('dismiss')
    try {
      const res = await fetch(`/api/admin/ai/changes/${change.id}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' })
      if (res.status === 401) return toLogin()
      if (res.ok) onDecided?.('rejected')
      await reload()
    } catch {
      toast({ status: 'error', title: S.dismiss, description: NETWORK_ERROR, duration: 6000, isClosable: true })
    } finally {
      setBusy(null)
    }
  }

  if (phase === 'hidden') {
    return (
      <Text fontSize="sm" color="page.fg-secondary" border="1px dashed" borderColor="page.border" borderRadius="xl" px={4} py={3} data-suggestion={change.id} data-suggestion-state="hidden">
        {S.hidden}
      </Text>
    )
  }

  const closedLine =
    open && change.editor_issuer_ended
      ? S.issuerEnded
      : change.state === 'applied'
      ? S.appliedSaved
      : change.state === 'rejected'
        ? S.dismissed
        : change.state === 'expired'
          ? S.expired
          : change.state === 'voided'
            ? S.voided
            : !open
              ? S.closed(change.state)
              : null

  return (
    <Box
      role="group"
      aria-labelledby={headingId}
      border="1px solid"
      borderColor={phase === 'applied' ? 'accent.500' : 'page.border'}
      borderRadius="xl"
      bg="page.bg"
      p={{ base: 4, md: 5 }}
      data-suggestion={change.id}
      data-suggestion-state={phase === 'applied' ? 'applied' : phase === 'changed' ? 'changed' : change.state}
    >
      <Flex align="center" justify="space-between" gap={3} flexWrap="wrap" mb={2}>
        <Text as="span" fontFamily={MONO} fontSize="10px" letterSpacing="0.16em" textTransform="uppercase" color="accent.text">
          {S.eyebrow}
          <Box as="span" color="page.fg" ml={2}>
            {fromChanges ? S.opened : S.forEditor}
          </Box>
        </Text>
        <Flex align="center" gap={2} minW={0}>
          {!open ? <ChangeStateChip state={change.state} /> : null}
          <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary">
            {actorText(change.actor)} · <When iso={change.created_at} now={now} />
          </Text>
        </Flex>
      </Flex>
      <Heading as="h3" id={headingId} fontSize="md" fontWeight={600} letterSpacing="-0.01em" wordBreak="break-word">
        {pre}
        {mono ? (
          <Text as="span" fontFamily={MONO} fontSize="0.92em" fontWeight={500}>
            {mono}
          </Text>
        ) : null}
        {post}
      </Heading>

      {closedLine ? (
        <Text fontSize="sm" mt={2} data-testid="suggestion-closed">
          {closedLine}
        </Text>
      ) : null}

      {open && !change.editor_issuer_ended && preview && diff && compact ? (
        <Stack spacing={3} mt={2}>
          {compact.docs.map((d) => (
            <Box key={d.doc.ref}>
              <DocHeader doc={d.doc} />
              {d.format === 'mdx' ? <MdxDiff lines={d.lines} context={1} /> : null}
            </Box>
          ))}
          {compact.truncated ? (
            <Button variant="link" size="sm" alignSelf="flex-start" color="accent.text" fontFamily={MONO} fontSize="12px" fontWeight={500} onClick={() => setSheetOpen(true)} minH={{ base: '44px', sm: 'auto' }}>
              ⋯ {diff.changed - compact.shown > 0 ? CHANGES_COPY.more(diff.changed - compact.shown, CHANGES_COPY.unit(diff.changed - compact.shown, diff.unit)) : CHANGES_COPY.reviewAll}
            </Button>
          ) : null}

          {preview.newLinks.length || preview.newEmbeds.length || preview.zeroWidth || change.notes.ai_written_earlier ? (
            <Box borderLeft="2px solid" borderColor="status.warning" pl={3} py={0.5} data-testid="suggestion-flags">
              <Text fontFamily={MONO} fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="page.fg-secondary" mb={1}>
                {CHANGES_COPY.flags.title}
              </Text>
              <Stack spacing={1} fontSize="13px">
                {preview.newLinks.length ? (
                  <Box>
                    <Text as="span">{CHANGES_COPY.flags.newLinks}:</Text>
                    <Box as="ul" listStyleType="none" mt={0.5}>
                      {preview.newLinks.map((l) => (
                        <Box as="li" key={l.url} fontFamily={MONO} fontSize="12px" overflowWrap="anywhere">
                          {l.url}
                          {l.flags.map((f) => (
                            <Text as="span" key={f} ml={2} color="status.warning" fontFamily={MONO} whiteSpace="nowrap">
                              ⚑ {LINK_FLAG_COPY[f] ?? f}
                            </Text>
                          ))}
                        </Box>
                      ))}
                    </Box>
                  </Box>
                ) : null}
                {preview.newEmbeds.length ? (
                  <Box>
                    <Text as="span">{CHANGES_COPY.flags.newEmbeds}:</Text>
                    <Box as="ul" listStyleType="none" mt={0.5}>
                      {preview.newEmbeds.map((u) => (
                        <Box as="li" key={u} fontFamily={MONO} fontSize="12px" overflowWrap="anywhere">
                          {u}
                        </Box>
                      ))}
                    </Box>
                  </Box>
                ) : null}
                {preview.zeroWidth ? <Text>{CHANGES_COPY.flags.zeroWidth(preview.zeroWidth)}</Text> : null}
                {change.notes.ai_written_earlier ? <Text>{CHANGES_COPY.flags.aiEarlier}</Text> : null}
              </Stack>
            </Box>
          ) : null}

          {change.rationale ? (
            <Text fontSize="sm" wordBreak="break-word" whiteSpace="pre-wrap">
              <Text as="span" color="page.fg-secondary">
                {CHANGES_COPY.modelSays}{' '}
              </Text>
              “{change.rationale}”
            </Text>
          ) : null}

          <Flex align="baseline" justify="space-between" gap={3} flexWrap="wrap">
            <Text fontSize="xs" color="page.fg-secondary" maxW="52ch">
              {S.note}
            </Text>
            <Button ref={reviewRef} variant="link" size="sm" color="accent.text" fontSize="13px" onClick={() => setSheetOpen(true)} minH={{ base: '44px', sm: 'auto' }}>
              {CHANGES_COPY.reviewAll} →
            </Button>
          </Flex>

          {phase === 'applied' ? (
            <Box role="status" data-testid="suggestion-applied">
              <Text fontSize="sm" fontWeight={500}>
                {S.applied}
              </Text>
              {editedSince ? (
                <Text fontSize="xs" color="page.fg-secondary" mt={1}>
                  {S.editedSince}
                </Text>
              ) : before.current ? (
                <Button size="sm" mt={2} {...outlineButtonProps} onClick={() => void undo()} isLoading={busy === 'undo'} minH={{ base: '44px', sm: 'auto' }}>
                  {S.undo}
                </Button>
              ) : null}
            </Box>
          ) : phase === 'changed' ? (
            <Box role="alert">
              <Text fontSize="sm" fontWeight={500}>
                {fromChanges ? S.changedProposal(noun) : S.changed(noun)}
              </Text>
              <Flex gap={2} mt={3} flexDirection={{ base: 'column', sm: 'row' }}>
                {onAskAgain && !fromChanges ? (
                  <Button size="sm" {...outlineButtonProps} onClick={onAskAgain} minH={{ base: '44px', sm: 'auto' }}>
                    {S.askAgain}
                  </Button>
                ) : null}
                <Button size="sm" {...outlineButtonProps} onClick={() => void dismiss()} isLoading={busy === 'dismiss'} minH={{ base: '44px', sm: 'auto' }}>
                  {S.dismiss}
                </Button>
              </Flex>
            </Box>
          ) : (
            <Flex gap={2} flexDirection={{ base: 'column', sm: 'row' }} align={{ base: 'stretch', sm: 'center' }}>
              <Button size="sm" {...primaryButtonProps} onClick={() => void apply()} isLoading={busy === 'apply'} loadingText={S.applying} minH={{ base: '44px', sm: 'auto' }} data-testid="suggestion-apply">
                {S.apply}
              </Button>
              <Button size="sm" {...outlineButtonProps} onClick={() => void dismiss()} isDisabled={busy !== null} isLoading={busy === 'dismiss'} minH={{ base: '44px', sm: 'auto' }}>
                {S.dismiss}
              </Button>
            </Flex>
          )}
        </Stack>
      ) : null}

      {preview && diff && (sheetOpen || sheetMounted) ? (
        <ChangeReviewSheet isOpen={sheetOpen} onClose={() => setSheetOpen(false)} finalFocusRef={reviewRef} change={change} diff={diff} onReadToEnd={() => {}} approve={null} />
      ) : null}
    </Box>
  )
}
