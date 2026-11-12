import { MEDIA_COPY } from './copy'

/**
 * One frame of a screen, window or tab the owner picks in the browser's own
 * dialog (getDisplayMedia; admin pages allow display-capture for this origin
 * only). The stream stops as soon as the frame is taken: nothing keeps
 * watching the screen.
 */

export const screenCaptureSupported = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function' && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

export class CaptureError extends Error {
  readonly cancelled: boolean
  constructor(message: string, cancelled = false) {
    super(message)
    this.name = 'CaptureError'
    this.cancelled = cancelled
  }
}

/** A video element's current frame as PNG. */
export function frameOf(video: HTMLVideoElement, type = 'image/png', quality?: number, mirror = false): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new CaptureError(MEDIA_COPY.screen.failed))
  if (mirror) {
    ctx.translate(canvas.width, 0)
    ctx.scale(-1, 1)
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new CaptureError(MEDIA_COPY.screen.failed))), type, quality))
}

export async function captureScreen(): Promise<Blob> {
  if (!screenCaptureSupported()) throw new CaptureError(MEDIA_COPY.screen.unsupported)
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false })
  } catch (err) {
    const cancelled = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')
    throw new CaptureError(cancelled ? MEDIA_COPY.screen.denied : MEDIA_COPY.screen.failed, cancelled)
  }
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  try {
    await video.play()
    // The first frame can be blank while the capture starts: wait for real dimensions and one more frame.
    for (let i = 0; i < 40 && (!video.videoWidth || !video.videoHeight); i++) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)))
    return await frameOf(video)
  } finally {
    for (const t of stream.getTracks()) t.stop()
    video.srcObject = null
  }
}
