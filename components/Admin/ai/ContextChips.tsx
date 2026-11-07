import type { ReactNode } from 'react'
import { Box, Flex, IconButton, Text } from '@chakra-ui/react'
import { FiX } from 'react-icons/fi'
import { MONO } from '../shell/ui'
import { pagePublicPath } from '../../../lib/pageNames'
import { ASK_COPY } from './askCopy'
import type { AskChip } from './askContext'

const C = ASK_COPY.chips

const wordCount = (s: string) => {
  const cjk = (s.match(/[㐀-鿿豈-﫿]/g) ?? []).length
  return cjk + s.replace(/[㐀-鿿豈-﫿]/g, ' ').split(/\s+/).filter(Boolean).length
}

/** A chip's words: "Post · slug · unsaved edits", "Selection · 42 words", "Page · /now", "CV · 中文". */
export function chipLabel(chip: AskChip, dirty = false): { kind: string; name: string | null; note: string | null } {
  switch (chip.kind) {
    case 'item':
      return { kind: chip.collection === 'blog' ? C.post : C.caseStudy, name: chip.slug, note: chip.editor && dirty ? C.unsaved : null }
    case 'page':
      return { kind: C.page, name: pagePublicPath(chip.name), note: chip.editor && dirty ? C.unsaved : null }
    case 'home':
      return { kind: C.home, name: null, note: null }
    case 'cv':
      return { kind: C.cv, name: C.cvLang(chip.lang), note: null }
    case 'media':
      return { kind: C.image, name: chip.name, note: null }
    case 'selection':
      return { kind: C.selection, name: null, note: C.words(wordCount(chip.text)) }
  }
}

const chipKey = (c: AskChip) =>
  c.kind === 'item' ? `item:${c.collection}/${c.slug}` : c.kind === 'page' ? `page:${c.name}` : c.kind === 'cv' ? `cv:${c.lang}` : c.kind === 'media' ? `media:${c.name}` : c.kind

/**
 * What the next message carries besides its words (PRODUCT §4.6): typed
 * references the server loads itself, not pasted text — except the open
 * editor's unsaved state and a selection, which only the page has. The
 * page attaches its own chip; one click removes any of them. A list, so a
 * screen reader hears how many there are and what each one is.
 */
export default function ContextChips({ chips, dirty, onRemove, add }: { chips: readonly AskChip[]; dirty: boolean; onRemove: (chip: AskChip) => void; add?: ReactNode }) {
  if (!chips.length && !add) return null
  return (
    <Flex align="center" gap={1.5} flexWrap="wrap" px={3} pt={2.5}>
      <Flex as="ul" listStyleType="none" gap={1.5} flexWrap="wrap" aria-label={C.label} data-context-chips="" display={chips.length ? 'flex' : 'none'}>
        {chips.map((chip) => {
          const l = chipLabel(chip, dirty)
          const label = [l.kind, l.name, l.note].filter(Boolean).join(' · ')
          return (
            <Box
              as="li"
              key={chipKey(chip)}
              display="inline-flex"
              alignItems="center"
              gap={1}
              maxW="100%"
              minW={0}
              border="1px solid"
              borderColor="page.border-strong"
              borderRadius="md"
              bg="page.bg-elevated"
              pl={2}
              pr={0.5}
              minH={{ base: '44px', md: '26px' }}
              data-chip={chip.kind}
            >
              <Text as="span" fontSize="12px" color="page.fg-secondary" whiteSpace="nowrap">
                {l.kind}
              </Text>
              {l.name ? (
                <Text as="span" fontFamily={MONO} fontSize="11px" color="page.fg" noOfLines={1} wordBreak="break-all" lang={chip.kind === 'cv' && chip.lang === 'zh' ? 'zh-Hans' : undefined}>
                  {l.name}
                </Text>
              ) : null}
              {l.note ? (
                <Text as="span" fontSize="11px" color={chip.kind === 'selection' ? 'page.fg-secondary' : 'status.warning'} whiteSpace="nowrap">
                  · {l.note}
                </Text>
              ) : null}
              <IconButton
                aria-label={ASK_COPY.chips.remove(label)}
                icon={<FiX aria-hidden />}
                size="xs"
                variant="ghost"
                color="page.fg-secondary"
                _hover={{ color: 'page.fg', bg: 'page.bg-overlay' }}
                minW={{ base: '44px', md: '22px' }}
                h={{ base: '44px', md: '22px' }}
                onClick={() => onRemove(chip)}
              />
            </Box>
          )
        })}
      </Flex>
      {add}
    </Flex>
  )
}
