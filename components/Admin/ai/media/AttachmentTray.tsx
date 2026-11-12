import { Box, CircularProgress, Flex, IconButton, Image, Text, Tooltip } from '@chakra-ui/react'
import { FiAlertCircle, FiFileText, FiMusic, FiX } from 'react-icons/fi'
import { MONO } from '../../shell/ui'
import { MEDIA_COPY } from './copy'
import { formatBytes, formatDuration } from './prepare'
import type { TrayItem } from './useAttachments'

const A = MEDIA_COPY.attach

function KindIcon({ item }: { item: TrayItem }) {
  if (item.kind === 'audio') return <FiMusic aria-hidden />
  return <FiFileText aria-hidden />
}

function status(item: TrayItem): string | null {
  if (item.status === 'preparing') return A.preparing
  if (item.status === 'uploading') return A.uploading(Math.round(item.progress * 100))
  if (item.status === 'error') return item.error ?? A.failed
  return null
}

function detail(item: TrayItem): string {
  const m = item.media
  if (item.kind === 'pdf') return [MEDIA_COPY.file.pdf, m?.pages ? MEDIA_COPY.file.pages(m.pages) : null, formatBytes(item.size)].filter(Boolean).join(' · ')
  if (item.kind === 'audio') return [MEDIA_COPY.file.audio, m?.durationMs ? formatDuration(m.durationMs) : null, formatBytes(item.size)].filter(Boolean).join(' · ')
  if (item.kind === 'text') return [MEDIA_COPY.file.text, formatBytes(item.size)].join(' · ')
  return formatBytes(item.size)
}

/**
 * The files going with the next message, inside the message box: images as
 * thumbnails, other files as cards, each with its progress, its reason when
 * it failed, and a remove button (44 px on touch). A list, so a screen reader
 * hears how many there are.
 */
export default function AttachmentTray({ items, onRemove, warning }: { items: readonly TrayItem[]; onRemove: (key: string) => void; warning?: string | null }) {
  if (!items.length && !warning) return null
  return (
    <Box px={3} pt={3}>
      {items.length ? (
        <Flex as="ul" listStyleType="none" gap={2} flexWrap="wrap" aria-label={A.tray} data-attachment-tray="">
          {items.map((item) => {
            const s = status(item)
            const failed = item.status === 'error'
            const busy = item.status === 'preparing' || item.status === 'uploading'
            const remove = (
              <IconButton
                aria-label={A.remove(item.name)}
                icon={<FiX aria-hidden />}
                size="xs"
                position="absolute"
                top="-7px"
                right="-7px"
                borderRadius="full"
                minW={{ base: '28px', md: '20px' }}
                h={{ base: '28px', md: '20px' }}
                // The visible circle stays small; the hit area is 44 px on a phone.
                _before={{ content: '""', position: 'absolute', inset: { base: '-8px', md: '-2px' } }}
                bg="page.fg"
                color="page.bg"
                _hover={{ bg: 'page.fg', opacity: 0.85 }}
                boxShadow="0 0 0 2px var(--chakra-colors-page-bg)"
                onClick={() => onRemove(item.key)}
                data-remove-attachment=""
              />
            )
            if (item.kind === 'image') {
              return (
                <Box as="li" key={item.key} position="relative" data-attachment={item.kind} data-status={item.status}>
                  <Tooltip label={s ? `${item.name} · ${s}` : `${item.name} · ${detail(item)}`} openDelay={400} hasArrow>
                    <Box
                      w="64px"
                      h="64px"
                      borderRadius="lg"
                      overflow="hidden"
                      border="1px solid"
                      borderColor={failed ? 'status.error' : 'page.border-strong'}
                      bg="page.bg-elevated"
                      position="relative"
                      tabIndex={0}
                      aria-label={[item.name, s].filter(Boolean).join(' · ')}
                    >
                      {item.preview ? <Image src={item.preview} alt="" w="100%" h="100%" objectFit="cover" opacity={busy ? 0.55 : 1} transition="opacity 160ms ease" /> : null}
                      {busy ? (
                        <Flex position="absolute" inset={0} align="center" justify="center">
                          <CircularProgress size="26px" thickness="10px" color="accent.500" trackColor="whiteAlpha.500" value={item.status === 'uploading' ? item.progress * 100 : undefined} isIndeterminate={item.status === 'preparing'} />
                        </Flex>
                      ) : null}
                      {failed ? (
                        <Flex position="absolute" inset={0} align="center" justify="center" bg="blackAlpha.600" color="white">
                          <FiAlertCircle aria-hidden />
                        </Flex>
                      ) : null}
                    </Box>
                  </Tooltip>
                  {remove}
                </Box>
              )
            }
            return (
              <Box as="li" key={item.key} position="relative" data-attachment={item.kind} data-status={item.status}>
                <Flex
                  align="center"
                  gap={2.5}
                  h="64px"
                  maxW="260px"
                  pl={3}
                  pr={4}
                  borderRadius="lg"
                  border="1px solid"
                  borderColor={failed ? 'status.error' : 'page.border-strong'}
                  bg="page.bg-elevated"
                  tabIndex={0}
                  aria-label={[item.name, s ?? detail(item)].join(' · ')}
                >
                  <Flex w="32px" h="32px" flexShrink={0} align="center" justify="center" borderRadius="md" bg="page.bg-overlay" color="accent.text" border="1px solid" borderColor="page.border" fontSize="16px">
                    {busy ? <CircularProgress size="20px" thickness="12px" color="accent.500" trackColor="page.border" value={item.status === 'uploading' ? item.progress * 100 : undefined} isIndeterminate={item.status === 'preparing'} /> : <KindIcon item={item} />}
                  </Flex>
                  <Box minW={0}>
                    <Text fontSize="13px" fontWeight={500} noOfLines={1} wordBreak="break-all">
                      {item.name}
                    </Text>
                    <Text fontFamily={MONO} fontSize="10.5px" color={failed ? 'status.error' : 'page.fg-secondary'} noOfLines={1}>
                      {s ?? detail(item)}
                    </Text>
                  </Box>
                </Flex>
                {remove}
              </Box>
            )
          })}
        </Flex>
      ) : null}
      {warning ? (
        <Text fontSize="12px" color="status.warning" mt={items.length ? 2 : 0} role="status">
          {warning}
        </Text>
      ) : null}
    </Box>
  )
}
