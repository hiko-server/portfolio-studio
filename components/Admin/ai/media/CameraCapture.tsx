import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, IconButton, Image, Modal, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalOverlay, Spinner, Text } from '@chakra-ui/react'
import { FiCamera, FiRefreshCw } from 'react-icons/fi'
import { outlineButtonProps, primaryButtonProps } from '../../shell/ui'
import { frameOf } from './capture'
import { MEDIA_COPY } from './copy'

const C = MEDIA_COPY.camera

/**
 * Take a photo with this device's camera (getUserMedia; admin pages allow the
 * camera for this origin only). The live preview stays on this page; only
 * the photo the owner keeps is attached. The camera stops when the dialog
 * closes. Phones use the system camera instead (an <input capture>), which
 * is better at it.
 */
export default function CameraCapture({ isOpen, onClose, onCapture }: { isOpen: boolean; onClose: () => void; onCapture: (blob: Blob) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [facing, setFacing] = useState<'user' | 'environment'>('user')
  const [state, setState] = useState<'starting' | 'live' | 'taken' | 'error'>('starting')
  const [error, setError] = useState('')
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null)
  const [cameras, setCameras] = useState(0)
  /** The latest camera request: one that resolves after the dialog closed or the camera was switched stops at once. */
  const request = useRef(0)

  const stopStream = useCallback(() => {
    request.current++
    for (const t of stream.current?.getTracks() ?? []) t.stop()
    stream.current = null
  }, [])

  const begin = useCallback(
    async (mode: 'user' | 'environment') => {
      stopStream()
      const mine = request.current
      setState('starting')
      setError('')
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
        if (mine !== request.current) {
          // Closed (or switched) while the browser was starting the camera: never leave it on.
          for (const t of s.getTracks()) t.stop()
          return
        }
        stream.current = s
        if (video.current) {
          video.current.srcObject = s
          await video.current.play().catch(() => {})
        }
        setState('live')
        try {
          const devices = await navigator.mediaDevices.enumerateDevices()
          setCameras(devices.filter((d) => d.kind === 'videoinput').length)
        } catch {
          setCameras(1)
        }
      } catch (err) {
        if (mine !== request.current) return
        setState('error')
        setError(err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? C.denied : err instanceof DOMException && err.name === 'NotFoundError' ? C.none : C.failed)
      }
    },
    [stopStream],
  )

  useEffect(() => {
    if (!isOpen) return
    void begin(facing)
    return () => stopStream()
    // Restarted only when it opens or the camera is switched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, facing])

  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url)
  }, [shot])

  const take = async () => {
    if (!video.current) return
    try {
      const blob = await frameOf(video.current, 'image/jpeg', 0.92, facing === 'user')
      setShot({ blob, url: URL.createObjectURL(blob) })
      setState('taken')
    } catch {
      setError(C.failed)
    }
  }

  const close = () => {
    stopStream()
    setShot(null)
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={close} size="xl" isCentered>
      <ModalOverlay />
      <ModalContent bg="page.bg-elevated" border="1px solid" borderColor="page.border" mx={4}>
        <ModalHeader fontSize="md">{C.title}</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <Box position="relative" borderRadius="lg" overflow="hidden" bg="black" aspectRatio={16 / 9} display="flex" alignItems="center" justifyContent="center">
            <Box
              as="video"
              ref={video}
              muted
              playsInline
              autoPlay
              w="100%"
              h="100%"
              objectFit="contain"
              transform={facing === 'user' ? 'scaleX(-1)' : undefined}
              display={state === 'live' ? 'block' : 'none'}
              aria-label={C.title}
            />
            {state === 'taken' && shot ? <Image src={shot.url} alt="" w="100%" h="100%" objectFit="contain" /> : null}
            {state === 'starting' ? (
              <Flex direction="column" align="center" gap={3} color="whiteAlpha.800" role="status">
                <Spinner />
                <Text fontSize="sm">{C.starting}</Text>
              </Flex>
            ) : null}
            {state === 'error' ? (
              <Text fontSize="sm" color="whiteAlpha.900" px={6} textAlign="center" role="alert">
                {error}
              </Text>
            ) : null}
            {state === 'live' && cameras > 1 ? (
              <IconButton
                aria-label={C.switch}
                icon={<FiRefreshCw aria-hidden />}
                position="absolute"
                top={3}
                right={3}
                size="sm"
                borderRadius="full"
                bg="blackAlpha.600"
                color="white"
                _hover={{ bg: 'blackAlpha.700' }}
                onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
              />
            ) : null}
          </Box>
        </ModalBody>
        <ModalFooter gap={2}>
          <Button size="sm" {...outlineButtonProps} onClick={close}>
            {C.cancel}
          </Button>
          {state === 'taken' && shot ? (
            <>
              <Button size="sm" {...outlineButtonProps} onClick={() => { setShot(null); setState('live') }}>
                {C.retake}
              </Button>
              <Button
                size="sm"
                {...primaryButtonProps}
                onClick={() => {
                  onCapture(shot.blob)
                  close()
                }}
              >
                {C.use}
              </Button>
            </>
          ) : (
            <Button size="sm" {...primaryButtonProps} leftIcon={<FiCamera aria-hidden />} onClick={() => void take()} isDisabled={state !== 'live'}>
              {C.capture}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
