import NextLink from 'next/link'
import { Box, Button, Flex, IconButton, Skeleton, Text } from '@chakra-ui/react'
import { FiPlus, FiTrash2 } from 'react-icons/fi'
import { MONO, outlineButtonProps } from '../shell/ui'
import { ASSISTANT_COPY } from './copy'
import { groupConversations, messageLang } from './assistantFormat'
import type { ConversationListItem } from './types'

const R = ASSISTANT_COPY.rail

/**
 * The conversations (PRODUCT §4.10): New chat, then every conversation
 * newest first, grouped by day; the one shown is marked (aria-current), the
 * one being answered says so. A row is a link (/admin/ai?c=<id>, so it opens
 * in a new tab too); its Delete appears on hover and is always reachable by
 * keyboard (and always shown on touch screens). The rail on wide screens, the
 * History drawer below that: the same list.
 */
export default function ConversationRail({
  items,
  activeId,
  writingId,
  now,
  loading,
  error,
  hasMore,
  onMore,
  onNew,
  onPick,
  onDelete,
}: {
  items: ConversationListItem[]
  activeId: string | null
  /** The conversation a run is writing into right now. */
  writingId: string | null
  now: number
  loading: boolean
  error: boolean
  hasMore: boolean
  onMore: () => void
  onNew: () => void
  /** A row was followed (the drawer closes). */
  onPick?: () => void
  onDelete: (c: ConversationListItem) => void
}) {
  const groups = groupConversations(items, now)
  return (
    <Box as="nav" aria-label={R.label}>
      <Button
        w="100%"
        size="sm"
        {...outlineButtonProps}
        leftIcon={<FiPlus aria-hidden />}
        justifyContent="flex-start"
        onClick={onNew}
        minH={{ base: '44px', lg: '32px' }}
        data-testid="new-chat"
      >
        {R.newChat}
      </Button>
      {loading && !items.length ? (
        <Box mt={5} aria-busy="true">
          <Skeleton h="14px" w="40%" mb={3} />
          <Skeleton h="28px" mb={2} />
          <Skeleton h="28px" mb={2} />
          <Skeleton h="28px" />
        </Box>
      ) : error && !items.length ? (
        <Text mt={5} fontSize="xs" color="page.fg-secondary">
          {R.loadError}
        </Text>
      ) : !items.length ? (
        <Text mt={5} fontSize="xs" color="page.fg-secondary">
          {R.empty}
        </Text>
      ) : (
        groups.map((g) => (
          <Box key={g.key} mt={5}>
            <Text as="h3" fontFamily={MONO} fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="page.fg-secondary" mb={1.5} px={2}>
              {g.label}
            </Text>
            <Box as="ul" listStyleType="none">
              {g.items.map((c) => {
                const active = c.id === activeId
                const writing = c.id === writingId
                return (
                  <Flex
                    as="li"
                    key={c.id}
                    align="center"
                    role="group"
                    borderRadius="md"
                    bg={active ? 'page.bg-overlay' : undefined}
                    _hover={{ bg: 'page.bg-overlay' }}
                    position="relative"
                  >
                    <Box
                      as={NextLink}
                      href={`/admin/ai?c=${encodeURIComponent(c.id)}`}
                      shallow
                      scroll={false}
                      onClick={onPick}
                      aria-current={active ? 'page' : undefined}
                      flex="1"
                      minW={0}
                      px={2}
                      py={{ base: 2.5, lg: 1.5 }}
                      fontSize="13px"
                      fontWeight={active ? 600 : 400}
                      color={active ? 'page.fg' : 'page.fg-secondary'}
                      _hover={{ color: 'page.fg', textDecoration: 'none' }}
                      _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500', outlineOffset: '-2px', borderRadius: 'md' }}
                      title={c.title}
                    >
                      <Flex align="center" gap={2} minW={0}>
                        {writing ? <Box as="span" aria-hidden w="6px" h="6px" borderRadius="full" bg="accent.500" flexShrink={0} /> : null}
                        <Text as="span" noOfLines={1} minW={0} lang={messageLang(c.title)}>
                          {c.title}
                        </Text>
                      </Flex>
                      {writing ? (
                        <Text as="span" srOnly>
                          {' '}
                          ({R.writing})
                        </Text>
                      ) : null}
                    </Box>
                    <IconButton
                      aria-label={R.delete(c.title)}
                      icon={<FiTrash2 aria-hidden />}
                      size="sm"
                      variant="ghost"
                      color="page.fg-secondary"
                      _hover={{ color: 'status.error', bg: 'transparent' }}
                      minW={{ base: '44px', lg: '28px' }}
                      h={{ base: '44px', lg: '28px' }}
                      opacity={{ base: 1, lg: 0 }}
                      _groupHover={{ opacity: 1 }}
                      _focusVisible={{ opacity: 1, outline: '2px solid', outlineColor: 'accent.500' }}
                      sx={{ '@media (hover: none)': { opacity: 1 } }}
                      isDisabled={writing}
                      onClick={() => onDelete(c)}
                    />
                  </Flex>
                )
              })}
            </Box>
          </Box>
        ))
      )}
      {hasMore ? (
        <Button mt={4} size="xs" variant="link" color="accent.text" onClick={onMore} px={2}>
          {R.more}
        </Button>
      ) : null}
    </Box>
  )
}
