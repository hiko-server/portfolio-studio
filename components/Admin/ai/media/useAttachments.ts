import { useCallback, useEffect, useRef, useState } from 'react'
import type { MediaKind, MediaView } from '../types'
import { classify, deleteUpload, MAX_FILES, prepareAudio, prepareImage, PrepareError, UploadError, uploadMedia } from './prepare'

/**
 * The files attached to the next message (the message box's tray). Each one
 * is prepared in the browser (prepare.ts) and uploaded at once, so by the
 * time the owner presses Send it is usually there already: Send waits only
 * while something is still on its way, and a failed file says why and can be
 * removed. Sent files leave the tray (`take`); removed ones are taken back
 * from the server.
 */

export type TrayStatus = 'preparing' | 'uploading' | 'ready' | 'error'

export type TrayItem = {
  key: string
  kind: MediaKind
  name: string
  size: number
  status: TrayStatus
  progress: number
  /** A local preview of an image (blob: URL, revoked when the item goes). */
  preview: string | null
  media: MediaView | null
  error: string | null
}

export type AddSource = File | { blob: Blob; name: string }

let seq = 0
const nextKey = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`

export function useAttachments({ onUnauthorized, onRejected }: { onUnauthorized?: () => void; onRejected?: (message: string) => void } = {}) {
  const [items, setItems] = useState<TrayItem[]>([])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const controllers = useRef(new Map<string, AbortController>())
  const callbacks = useRef({ onUnauthorized, onRejected })
  callbacks.current = { onUnauthorized, onRejected }

  const patch = useCallback((key: string, p: Partial<TrayItem>) => {
    setItems((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)))
  }, [])

  // Previews belong to this page: revoked on the way out.
  useEffect(
    () => () => {
      for (const it of itemsRef.current) if (it.preview) URL.revokeObjectURL(it.preview)
      for (const c of controllers.current.values()) c.abort()
    },
    [],
  )

  const process = useCallback(
    async (key: string, kind: MediaKind, blob: Blob, name: string) => {
      const ac = new AbortController()
      controllers.current.set(key, ac)
      try {
        let ready: Blob = blob
        let readyName = name
        if (kind === 'image') {
          const img = await prepareImage(blob, name)
          ready = img.blob
          readyName = img.name
        } else if (kind === 'audio' && !/^audio\/(wav|x-wav|wave|mpeg|mp3)$/i.test(blob.type)) {
          const a = await prepareAudio(blob, name)
          ready = a.blob
          readyName = a.name
        }
        if (ac.signal.aborted) return
        patch(key, { status: 'uploading', size: ready.size, name: readyName })
        const media = await uploadMedia(ready, readyName, { signal: ac.signal, onProgress: (p) => patch(key, { progress: p }) })
        if (ac.signal.aborted) {
          deleteUpload(media.id)
          return
        }
        patch(key, { status: 'ready', progress: 1, media, name: media.name, size: media.size })
      } catch (err) {
        if (ac.signal.aborted) return
        if (err instanceof UploadError && err.status === 401) callbacks.current.onUnauthorized?.()
        const message = err instanceof PrepareError || err instanceof UploadError ? err.message : 'The file could not be attached.'
        patch(key, { status: 'error', error: message })
      } finally {
        controllers.current.delete(key)
      }
    },
    [patch],
  )

  /** Attach files (picked, dropped, pasted, captured). Returns how many were taken. */
  const add = useCallback(
    (sources: readonly AddSource[]): number => {
      const room = MAX_FILES - itemsRef.current.length
      const accepted: Array<{ item: TrayItem; blob: Blob }> = []
      const refused: string[] = []
      for (const src of sources) {
        const blob = src instanceof Blob ? src : src.blob
        const name = src instanceof File ? src.name || 'file' : (src as { name: string }).name
        const kind = classify({ type: blob.type, name })
        if (!kind) {
          refused.push(name)
          continue
        }
        if (accepted.length >= room) {
          callbacks.current.onRejected?.(`At most ${MAX_FILES} files go with one message.`)
          break
        }
        const preview = kind === 'image' ? URL.createObjectURL(blob) : null
        accepted.push({ item: { key: nextKey(), kind, name, size: blob.size, status: 'preparing', progress: 0, preview, media: null, error: null }, blob })
      }
      if (refused.length) callbacks.current.onRejected?.(`${refused.length === 1 ? `“${refused[0]}” is` : `${refused.length} files are`} not something the assistant takes: attach images, PDFs, text or code, or audio.`)
      if (!accepted.length) return 0
      setItems((list) => [...list, ...accepted.map((a) => a.item)])
      for (const a of accepted) void process(a.item.key, a.item.kind, a.blob, a.item.name)
      return accepted.length
    },
    [process],
  )

  const remove = useCallback((key: string) => {
    const it = itemsRef.current.find((x) => x.key === key)
    if (!it) return
    controllers.current.get(key)?.abort()
    if (it.media) deleteUpload(it.media.id)
    if (it.preview) URL.revokeObjectURL(it.preview)
    setItems((list) => list.filter((x) => x.key !== key))
  }, [])

  /** The ready files go with a message: they leave the tray (the server now owns them). */
  const take = useCallback((): { ids: string[]; media: MediaView[]; previews: Record<string, string> } => {
    const ready = itemsRef.current.filter((x) => x.status === 'ready' && x.media)
    const previews: Record<string, string> = {}
    for (const it of ready) if (it.preview && it.media) previews[it.media.id] = it.preview
    setItems((list) => list.filter((x) => !(x.status === 'ready' && x.media)))
    return { ids: ready.map((x) => x.media!.id), media: ready.map((x) => x.media!), previews }
  }, [])

  /** Put files back after a send the server refused (their ids are still pending). */
  const restore = useCallback((media: readonly MediaView[], previews: Record<string, string> = {}) => {
    if (!media.length) return
    setItems((list) => [
      ...media.map((m) => ({ key: nextKey(), kind: m.kind, name: m.name, size: m.size, status: 'ready' as const, progress: 1, preview: previews[m.id] ?? null, media: m, error: null })),
      ...list,
    ])
  }, [])

  const clear = useCallback(() => {
    for (const it of itemsRef.current) {
      controllers.current.get(it.key)?.abort()
      if (it.media) deleteUpload(it.media.id)
      if (it.preview) URL.revokeObjectURL(it.preview)
    }
    setItems([])
  }, [])

  const busy = items.some((x) => x.status === 'preparing' || x.status === 'uploading')
  const ready = items.filter((x) => x.status === 'ready')
  return { items, add, remove, take, restore, clear, busy, readyCount: ready.length, kinds: new Set(ready.map((x) => x.kind)) }
}

export type Attachments = ReturnType<typeof useAttachments>
