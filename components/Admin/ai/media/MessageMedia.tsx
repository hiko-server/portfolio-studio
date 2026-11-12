import { useEffect, useState } from 'react'
import { Box, Button, Flex, Grid, IconButton, Image, Link, Modal, ModalContent, ModalOverlay, Text, VisuallyHidden } from '@chakra-ui/react'
import { FiChevronLeft, FiChevronRight, FiDownload, FiFileText, FiMaximize, FiMinimize, FiX } from 'react-icons/fi'
import { MONO } from '../../shell/ui'
import type { MediaView } from '../types'
import { MEDIA_COPY } from './copy'
import { formatBytes, formatDuration, mediaUrl } from './prepare'

const F = MEDIA_COPY.file
const V = MEDIA_COPY.viewer

/** Where an image is drawn from: the server's copy, or (while the message is on its way) the local preview. */
const srcOf = (m: MediaView, previews?: Record<string, string>) => previews?.[m.id] ?? mediaUrl(m.id)

function FileCard({ m }: { m: MediaView }) {
  const meta =
    m.kind === 'pdf'
      ? [F.pdf, m.pages ? F.pages(m.pages) : null, formatBytes(m.size)]
      : m.kind === 'text'
        ? [F.text, m.chars ? F.chars(m.chars) : null, formatBytes(m.size)]
        : [F.audio, m.durationMs ? formatDuration(m.durationMs) : null, formatBytes(m.size)]
  return (
    <Link
      href={mediaUrl(m.id, true)}
      download={m.name}
      display="flex"
      alignItems="center"
      gap={2.5}
      minH="52px"
      maxW="300px"
      px={3}
      py={2}
      borderRadius="lg"
      border="1px solid"
      borderColor="page.border"
      bg="page.bg"
      _hover={{ borderColor: 'page.border-strong', textDecoration: 'none', bg: 'page.hover' }}
      aria-label={F.download(m.name)}
      data-media-file={m.kind}
    >
      <Flex w="30px" h="30px" flexShrink={0} align="center" justify="center" borderRadius="md" bg="page.bg-overlay" color="accent.text" border="1px solid" borderColor="page.border">
        <FiFileText aria-hidden />
      </Flex>
      <Box minW={0} flex="1">
        <Text fontSize="13px" fontWeight={500} noOfLines={1} wordBreak="break-all" color="page.fg">
          {m.name}
        </Text>
        <Text fontFamily={MONO} fontSize="10.5px" color="page.fg-secondary" noOfLines={1}>
          {meta.filter(Boolean).join(' · ')}
        </Text>
      </Box>
      <Box color="page.fg-secondary" flexShrink={0} aria-hidden>
        <FiDownload />
      </Box>
    </Link>
  )
}

function AudioCard({ m }: { m: MediaView }) {
  return (
    <Box maxW="320px" w="100%" border="1px solid" borderColor="page.border" borderRadius="lg" bg="page.bg" px={3} py={2} data-media-file="audio">
      <Flex justify="space-between" gap={2} mb={1.5}>
        <Text fontSize="12px" fontWeight={500} noOfLines={1} wordBreak="break-all">
          {m.name}
        </Text>
        <Text fontFamily={MONO} fontSize="10.5px" color="page.fg-secondary" flexShrink={0}>
          {m.durationMs ? formatDuration(m.durationMs) : formatBytes(m.size)}
        </Text>
      </Flex>
      <Box as="audio" controls preload="metadata" src={mediaUrl(m.id)} w="100%" h="36px" aria-label={m.name} />
    </Box>
  )
}

/**
 * The files of the owner's message, under its words: images as a grid that
 * opens the viewer, PDFs and text files as cards that download, audio as a
 * player. All from this site's own address (no remote image ever loads).
 */
export function MessageMedia({ media, previews, onOpenImage }: { media: readonly MediaView[]; previews?: Record<string, string>; onOpenImage?: (id: string) => void }) {
  const images = media.filter((m) => m.kind === 'image')
  const others = media.filter((m) => m.kind !== 'image')
  if (!media.length) return null
  const one = images.length === 1
  return (
    <Flex direction="column" align="flex-end" gap={2} mb={1.5} data-message-media="">
      {images.length ? (
        <Grid templateColumns={one ? '1fr' : `repeat(${Math.min(images.length, 3)}, minmax(0, 1fr))`} gap={1.5} w={one ? 'auto' : { base: '100%', md: images.length === 2 ? '360px' : '420px' }} maxW="100%">
          {images.map((m) => {
            const ratio = m.width && m.height ? m.width / m.height : 1
            return (
              <Button
                key={m.id}
                variant="unstyled"
                h="auto"
                minW={0}
                p={0}
                display="block"
                borderRadius="xl"
                overflow="hidden"
                border="1px solid"
                borderColor="page.border"
                bg="page.bg-elevated"
                _hover={{ borderColor: 'page.border-strong' }}
                _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500', outlineOffset: '2px' }}
                onClick={() => onOpenImage?.(m.id)}
                aria-label={`${V.label}: ${m.name}`}
                cursor="zoom-in"
                data-media-image=""
              >
                <Image
                  src={srcOf(m, previews)}
                  alt={m.name}
                  loading="lazy"
                  decoding="async"
                  w="100%"
                  h={one ? 'auto' : { base: '96px', md: '128px' }}
                  maxH={one ? '320px' : undefined}
                  maxW={one ? { base: '100%', md: '360px' } : undefined}
                  objectFit="cover"
                  style={one && m.width && m.height ? { aspectRatio: String(ratio) } : undefined}
                />
              </Button>
            )
          })}
        </Grid>
      ) : null}
      {others.map((m) => (m.kind === 'audio' ? <AudioCard key={m.id} m={m} /> : <FileCard key={m.id} m={m} />))}
    </Flex>
  )
}

/**
 * The image viewer: one image of the conversation at a time, fitted or at
 * its actual size, ← → between the conversation's images, Esc to close, and
 * its download. The image comes from this site.
 */
export function ImageViewer({ images, openId, onClose }: { images: readonly MediaView[]; openId: string | null; onClose: () => void }) {
  const [index, setIndex] = useState(0)
  const [actual, setActual] = useState(false)
  // Only a new image to open moves the viewer: a turn arriving while it is open keeps the image and its zoom.
  useEffect(() => {
    if (!openId) return
    const i = images.findIndex((m) => m.id === openId)
    setIndex(i >= 0 ? i : 0)
    setActual(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId])
  const m = images[index]
  const go = (d: number) => {
    if (images.length < 2) return
    setIndex((i) => (i + d + images.length) % images.length)
    setActual(false)
  }
  return (
    <Modal isOpen={!!openId && !!m} onClose={onClose} size="full" motionPreset="none">
      <ModalOverlay bg="blackAlpha.900" backdropFilter="blur(6px)" />
      <ModalContent
        bg="transparent"
        boxShadow="none"
        m={0}
        aria-label={V.label}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') go(1)
          else if (e.key === 'ArrowLeft') go(-1)
        }}
      >
        {m ? (
          <Flex direction="column" h="100dvh" color="white">
            <Flex align="center" justify="space-between" gap={3} px={{ base: 3, md: 5 }} py={3} flexShrink={0}>
              <Box minW={0}>
                <Text fontSize="sm" fontWeight={500} noOfLines={1}>
                  {m.name}
                </Text>
                <Text fontFamily={MONO} fontSize="11px" color="whiteAlpha.700">
                  {[m.width && m.height ? `${m.width}×${m.height}` : null, formatBytes(m.size), images.length > 1 ? V.count(index + 1, images.length) : null].filter(Boolean).join(' · ')}
                </Text>
              </Box>
              <Flex gap={1} flexShrink={0}>
                <IconButton aria-label={actual ? V.fit : V.actual} icon={actual ? <FiMinimize aria-hidden /> : <FiMaximize aria-hidden />} variant="ghost" color="white" _hover={{ bg: 'whiteAlpha.200' }} onClick={() => setActual((v) => !v)} />
                <IconButton as="a" href={mediaUrl(m.id, true)} download={m.name} aria-label={V.download} icon={<FiDownload aria-hidden />} variant="ghost" color="white" _hover={{ bg: 'whiteAlpha.200' }} />
                <IconButton aria-label={V.close} icon={<FiX aria-hidden />} variant="ghost" color="white" _hover={{ bg: 'whiteAlpha.200' }} onClick={onClose} data-autofocus="" />
              </Flex>
            </Flex>
            <Flex flex="1" minH={0} align={actual ? 'flex-start' : 'center'} justify={actual ? 'flex-start' : 'center'} overflow="auto" px={{ base: 2, md: 16 }} pb={4} position="relative" onClick={(e) => e.target === e.currentTarget && onClose()}>
              <Image
                key={m.id}
                src={mediaUrl(m.id)}
                alt={m.name}
                maxW={actual ? 'none' : '100%'}
                maxH={actual ? 'none' : '100%'}
                objectFit="contain"
                borderRadius={actual ? 0 : 'md'}
                cursor={actual ? 'zoom-out' : 'zoom-in'}
                onClick={() => setActual((v) => !v)}
                m={actual ? 'auto' : undefined}
              />
              {images.length > 1 ? (
                <>
                  <IconButton aria-label={V.prev} icon={<FiChevronLeft aria-hidden />} position="fixed" left={{ base: 1, md: 4 }} top="50%" transform="translateY(-50%)" borderRadius="full" bg="blackAlpha.600" color="white" _hover={{ bg: 'blackAlpha.800' }} onClick={() => go(-1)} size="lg" />
                  <IconButton aria-label={V.next} icon={<FiChevronRight aria-hidden />} position="fixed" right={{ base: 1, md: 4 }} top="50%" transform="translateY(-50%)" borderRadius="full" bg="blackAlpha.600" color="white" _hover={{ bg: 'blackAlpha.800' }} onClick={() => go(1)} size="lg" />
                </>
              ) : null}
            </Flex>
            <VisuallyHidden aria-live="polite">{images.length > 1 ? V.count(index + 1, images.length) : ''}</VisuallyHidden>
          </Flex>
        ) : null}
      </ModalContent>
    </Modal>
  )
}
