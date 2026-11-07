import { useMemo } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import type { DiffEntry } from '../shell/jsonDiff'
import type { DiffLine } from '../shell/textDiff'
import LineDiffView from '../shell/LineDiffView'
import WordDiffText from '../shell/WordDiffText'
import { MONO } from '../shell/ui'
import { afterSide, beforeSide, diffWords } from '../../../lib/wordDiff'
import { CHANGES_COPY } from './copy'
import { shortText, valueText } from './changeFormat'
import type { PreviewDocument } from './types'

/**
 * The parts of an AI change's diff (design §8.2): a document's header (its
 * server-composed label and public address), its MDX lines through
 * LineDiffView (real <ins>/<del>, word highlights), and its JSON values as
 * path rows. The card shows a compact slice, the review sheet everything;
 * in the sheet nothing is ever shortened.
 */

export function DocHeader({ doc, counts }: { doc: PreviewDocument; counts?: { added: number; removed: number } | null }) {
  return (
    <Flex align="baseline" justify="space-between" gap={3} flexWrap="wrap" mb={1.5}>
      <Text fontSize="12px" fontWeight={600} minW={0} wordBreak="break-word">
        {doc.label}
        {doc.publicUrl ? (
          <Text as="span" fontFamily={MONO} fontWeight={400} color="page.fg-secondary" ml={2} overflowWrap="anywhere">
            {doc.publicUrl}
          </Text>
        ) : null}
      </Text>
      {counts && (counts.added || counts.removed) ? (
        <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" className="tnum" flexShrink={0}>
          +{counts.added} / −{counts.removed}
        </Text>
      ) : null}
    </Flex>
  )
}

export function lineCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}

/** Longest text compared word by word; longer values are shown whole on both sides. */
const WORD_DIFF_MAX_CHARS = 4000

function words(e: DiffEntry) {
  if (e.kind !== 'changed' || typeof e.before !== 'string' || typeof e.after !== 'string') return null
  if (e.before.length > WORD_DIFF_MAX_CHARS || e.after.length > WORD_DIFF_MAX_CHARS) return null
  const d = diffWords(e.before, e.after)
  return d.tooLarge ? null : { before: beforeSide(d.segments), after: afterSide(d.segments) }
}

function JsonEntry({ e, shorten }: { e: DiffEntry; shorten: boolean }) {
  const w = useMemo(() => (shorten ? null : words(e)), [e, shorten])
  const side = (v: unknown) => (shorten ? shortText(valueText(v)) : valueText(v))
  return (
    <Box py={2} px={3} borderBottom="1px solid" borderColor="page.border" _last={{ borderBottom: 'none' }}>
      <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" wordBreak="break-all" mb={1}>
        {e.path === '(whole)' ? (e.kind === 'removed' ? CHANGES_COPY.removedWhole : '') : e.path}
      </Text>
      {e.kind !== 'added' ? (
        <Box as="del" display="block" textDecoration="none" bg="rgba(239,68,68,0.12)" px={2} py={0.5} borderRadius="sm" fontFamily={MONO} fontSize="12px" whiteSpace="pre-wrap" wordBreak="break-word">
          {'− '}
          {w ? <WordDiffText segments={w.before} side="del" /> : side(e.before)}
        </Box>
      ) : null}
      {e.kind !== 'removed' ? (
        <Box as="ins" display="block" textDecoration="none" bg="rgba(34,197,94,0.12)" px={2} py={0.5} mt={e.kind === 'changed' ? 1 : 0} borderRadius="sm" fontFamily={MONO} fontSize="12px" whiteSpace="pre-wrap" wordBreak="break-word">
          {'+ '}
          {w ? <WordDiffText segments={w.after} side="add" /> : side(e.after)}
        </Box>
      ) : null}
    </Box>
  )
}

/** JSON values that changed, each with its path; `shortened` marks values the card cut (the sheet never does). */
export function JsonDiffRows({ entries }: { entries: Array<DiffEntry & { shortened?: boolean }> }) {
  return (
    <Box border="1px solid" borderColor="page.border" borderRadius="md" bg="page.bg" data-testid="json-diff">
      {entries.map((e, i) => (
        <JsonEntry key={`${e.path}:${i}`} e={e} shorten={e.shortened === true} />
      ))}
    </Box>
  )
}

/** One MDX document's lines (unchanged runs folded to "⋯ n unchanged lines"). */
export function MdxDiff({ lines, context }: { lines: DiffLine[]; context: number }) {
  if (!lines.some((l) => l.kind !== 'same')) {
    return (
      <Text fontSize="xs" color="page.fg-secondary">
        {CHANGES_COPY.noVisibleText}
      </Text>
    )
  }
  return <LineDiffView lines={lines} context={context} />
}
