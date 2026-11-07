import { createParser, type EventSourceMessage } from 'eventsource-parser'
import { ProviderError } from './types'

/**
 * Server-sent events from a provider (SERVER-ONLY, design §7.7), read with
 * the spec-compliant `eventsource-parser`: CRLF, comments, multi-line data
 * and a chunk boundary anywhere — inside an event, a line ending or a UTF-8
 * character — all read the same. Comments are real traffic (DeepSeek's
 * `: keep-alive`, OpenRouter's `: OPENROUTER PROCESSING`): they are not
 * events, but they did arrive, so the idle timer of the transport has already
 * counted their bytes.
 */

export type SseMessage = { event: string | null; data: string }

/** The events of an SSE body, decoded as UTF-8 across chunk boundaries. */
export async function* sseMessages(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  const queue: SseMessage[] = []
  const parser = createParser({
    onEvent: (e: EventSourceMessage) => queue.push({ event: e.event ?? null, data: e.data }),
  })
  const decoder = new TextDecoder('utf-8')
  for await (const chunk of body) {
    parser.feed(decoder.decode(chunk, { stream: true }))
    while (queue.length) yield queue.shift() as SseMessage
  }
  const tail = decoder.decode()
  if (tail) parser.feed(tail)
  // A final event with no blank line after it is not dispatched (the spec), so EOF mid-event yields nothing more.
  while (queue.length) yield queue.shift() as SseMessage
}

/**
 * Wrap an iterator so that `idleMs` without a value fails it with a
 * ProviderError('timeout'), and the wrapped iterator is closed. An SDK's
 * own timeout stops at the response headers and never protects a stream
 * (PROVIDERS §1.6), so every model stream is read through this.
 */
export async function* watchIdle<T>(source: AsyncIterable<T>, idleMs: number, onIdle?: () => void): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stalled = false
  try {
    for (;;) {
      const next = it.next()
      const idle = new Promise<'idle'>((resolve) => {
        timer = setTimeout(() => resolve('idle'), Math.max(1, idleMs))
      })
      const r = await Promise.race([next, idle])
      clearTimeout(timer)
      if (r === 'idle') {
        stalled = true
        // Settle the pending read so nothing is left unhandled; onIdle tears the transport down.
        next.catch(() => {})
        onIdle?.()
        throw new ProviderError('timeout', `No data from the provider for ${Math.round(idleMs / 1000)} s`, { retryable: false })
      }
      if (r.done) return
      yield r.value
    }
  } finally {
    clearTimeout(timer)
    // A stalled source is still inside its pending read: closing it would wait for that read, so it is
    // closed without waiting (onIdle already aborted its transport).
    const closing = it.return?.()
    if (closing) {
      if (stalled) closing.catch(() => {})
      else
        try {
          await closing
        } catch {
          // Closing a stream that already failed: nothing more to report.
        }
    }
  }
}

/** A JSON object from an SSE data line, or null for anything that is not one (`[DONE]` included). */
export function jsonData(data: string): Record<string, unknown> | null {
  if (!data || data === '[DONE]') return null
  try {
    const v = JSON.parse(data)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
