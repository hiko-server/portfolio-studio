/**
 * The browser's reader of a run's server-sent events (design §7.7): a small
 * parser with no dependency, over a same-origin `fetch` body (CSP
 * `connect-src 'self'`; no EventSource, which cannot POST or carry the
 * CSRF rules the proxy applies to admin writes).
 *
 * It follows the event-stream format: lines end with LF, CRLF or CR; a line
 * starting with ":" is a comment (the server's pings may be either); `data:`
 * lines join with "\n"; a blank line ends the event; a UTF-8 BOM at the start
 * is dropped; a field's one leading space is dropped. `id` is kept as a
 * number when it is one (the run's monotonic seq). Pure and synchronous, so
 * tests feed it chunks split anywhere, inside a UTF-8 character included
 * (the decoder in readEventStream keeps those whole).
 */

export type SseFrame = { event: string; id: number | null; data: string }

export type SseParser = {
  /** Feed decoded text, split anywhere. */
  push(text: string): void
  /** The stream ended: an event without its blank line is dropped, as the format says. */
  end(): void
}

export function createSseParser(onFrame: (frame: SseFrame) => void): SseParser {
  let buffer = ''
  let started = false
  let event = ''
  let id: number | null = null
  let data: string[] = []
  let hasData = false
  // A CR at the very end of a chunk may be the first half of CRLF.
  let pendingCr = false

  const dispatch = () => {
    if (hasData) onFrame({ event: event || 'message', id, data: data.join('\n') })
    event = ''
    id = null
    data = []
    hasData = false
  }

  const line = (l: string) => {
    if (l === '') return dispatch()
    if (l.startsWith(':')) return
    const colon = l.indexOf(':')
    const field = colon < 0 ? l : l.slice(0, colon)
    let value = colon < 0 ? '' : l.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') {
      data.push(value)
      hasData = true
    } else if (field === 'id') {
      if (!value.includes('\u0000')) id = /^\d{1,15}$/.test(value) ? Number(value) : null
    }
    // `retry` and unknown fields are ignored.
  }

  return {
    push(text: string) {
      if (!text) return
      if (!started) {
        started = true
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      }
      if (pendingCr) {
        pendingCr = false
        if (text.startsWith('\n')) text = text.slice(1)
      }
      buffer += text
      let start = 0
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer.charCodeAt(i)
        if (c !== 10 && c !== 13) continue
        line(buffer.slice(start, i))
        if (c === 13) {
          if (i + 1 < buffer.length) {
            if (buffer.charCodeAt(i + 1) === 10) i++
          } else pendingCr = true
        }
        start = i + 1
      }
      buffer = buffer.slice(start)
    },
    end() {
      buffer = ''
      event = ''
      id = null
      data = []
      hasData = false
    },
  }
}

/**
 * Read an event-stream response to its end (or until `signal` aborts),
 * calling `onFrame` for every event. Resolves when the stream closes; rejects
 * with the reader's error (a dropped connection) unless aborted.
 */
export async function readEventStream(res: Response, onFrame: (frame: SseFrame) => void, signal?: AbortSignal): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const parser = createSseParser(onFrame)
  const cancel = () => {
    reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode())
    parser.end()
  } catch (err) {
    if (signal?.aborted) return
    throw err
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

/** Is this response the run's event stream (and not a JSON refusal)? */
export function isEventStream(res: Response): boolean {
  return (res.headers.get('content-type') || '').toLowerCase().startsWith('text/event-stream')
}
