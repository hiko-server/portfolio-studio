import dns from 'node:dns'
import { safeFetch, safeFetchStream, SafeFetchError, type SafeStream } from '../../security/safeFetch'
import { createScrubber } from '../scrub'
import { kindOfStatus, plainProviderText, ProviderError, retryAfterMs, scrubbedError, settled, type ModelEvent } from './types'

/**
 * The transport of the two fetch wires (SERVER-ONLY, design §7.6, §7.7):
 * every request goes through lib/security/safeFetch — the URL vetted, every
 * address public (or, for a local origin listed in AI_LOCAL_PROVIDER_ORIGINS
 * while the site is local-only, loopback), re-vetted per request, the socket
 * pinned, redirects refused, no Accept-Encoding.
 *
 * Retries happen only before a byte of the answer streamed: a connect error,
 * 408, 409, 429, 5xx or 529, at most twice, with jittered backoff from 500 ms
 * to 8 s, honouring `retry-after` up to 30 s (longer is surfaced, not
 * waited). Error bodies are hostile: read capped, scrubbed of the key, folded
 * to plain text — the owner reads them, a model never does. What a provider
 * says inside a 200 stream is just as hostile: every adapter of these wires
 * hands its failures out through `withoutKey` (`guardedStream`), so no
 * ProviderError of theirs carries the key, whichever line built it (§7.4).
 */

export const MAX_RETRIES = 2
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 8_000
/** A provider asking for a longer wait than this is answered with its error, not waited for. */
export const RETRY_AFTER_MAX_MS = 30_000
/** Error bodies are read up to this many bytes. */
const ERROR_BODY_MAX = 64 * 1024
/** A model call's whole exchange (§7.7: model call 15 min). */
export const MODEL_CALL_MS = 15 * 60_000

export type Endpoint = {
  /** Canonical base URL, no trailing slash. */
  baseUrl: string
  /** The key, or null for a keyless local server. */
  apiKey: string | null
  connectTimeoutMs: number
  idleTimeoutMs: number
  /** Exact local origins this request may use (AI_LOCAL_PROVIDER_ORIGINS, local-only sites). */
  localOrigins: readonly string[]
}

/** 198.18.0.0/15: what a VPN or proxy in fake-IP mode answers (§7.7: name the likely cause). */
export function isFakeIpAddress(address: string): boolean {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/i.exec(address)
  return !!m && Number(m[1]) === 198 && (Number(m[2]) === 18 || Number(m[2]) === 19)
}

export const FAKE_IP_HINT = 'This address is in a range a VPN or proxy uses in fake-IP mode. Switch it to real-IP mode for this host.'

/** A resolver that remembers what it answered, so a refused address can name its likely cause. */
function observingResolver(): { resolve: (host: string) => Promise<string[]>; seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async resolve(host: string) {
      const rows = await dns.promises.lookup(host, { all: true, verbatim: true })
      const out = rows.map((r) => r.address)
      seen.push(...out)
      return out
    },
  }
}

function headersFor(ep: Endpoint, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}), ...extra }
}

/** A transport failure as a ProviderError, with the key scrubbed from anything quoted. */
export function transportError(err: unknown, ep: Pick<Endpoint, 'apiKey'>, seen: readonly string[] = []): ProviderError {
  const scrub = createScrubber([ep.apiKey])
  if (err instanceof ProviderError) return err
  if (err instanceof SafeFetchError) {
    const msg = scrub.text(err.message)
    switch (err.code) {
      case 'ABORTED':
        return new ProviderError('aborted', 'The request was cancelled')
      case 'BLOCKED_HOST':
        return new ProviderError('blocked', seen.some(isFakeIpAddress) ? FAKE_IP_HINT : `This provider’s address is not allowed: ${msg}`)
      case 'BAD_URL':
        return new ProviderError('config', `This provider’s address is not allowed: ${msg}`)
      case 'REDIRECTS':
        return new ProviderError('config', 'The provider answered with a redirect, which is never followed with a key. Check the base URL.')
      case 'TOO_LARGE':
        return new ProviderError('too_large', 'The provider’s answer was larger than this site accepts.')
      case 'IDLE':
        return new ProviderError('timeout', msg)
      case 'TIMEOUT':
        return new ProviderError('timeout', msg, { retryable: true })
      case 'DNS':
      case 'NETWORK':
        return new ProviderError('network', msg, { retryable: true })
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return new ProviderError('network', scrub.text(message), { retryable: true })
}

/**
 * Anything a fetch adapter throws, as a ProviderError with the key of `ep`
 * in none of its words (§7.4: message, stack, the provider's words and the
 * request id). The one exit of the chat and responses wires.
 */
export function withoutKey(err: unknown, ep: Pick<Endpoint, 'apiKey'>): ProviderError {
  if (!(err instanceof ProviderError)) return transportError(err, ep)
  const scrub = createScrubber([ep.apiKey])
  return scrub.active ? scrubbedError(err, scrub.text) : err
}

/** An adapter's model turn with every failure passed through `withoutKey`. */
export async function* guardedStream(events: AsyncIterable<ModelEvent>, ep: Pick<Endpoint, 'apiKey'>): AsyncGenerator<ModelEvent> {
  try {
    yield* events
  } catch (err) {
    throw withoutKey(err, ep)
  }
}

/** The provider's message from an error body, by the shapes the dialects use. */
export function providerMessageOf(body: string): string {
  let v: unknown
  try {
    v = JSON.parse(body)
  } catch {
    return plainProviderText(body)
  }
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const err = o.error
  if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') return plainProviderText((err as Record<string, unknown>).message)
  if (typeof err === 'string') return plainProviderText(err)
  if (typeof o.message === 'string') return plainProviderText(o.message)
  if (typeof o.detail === 'string') return plainProviderText(o.detail)
  const base = o.base_resp
  if (base && typeof base === 'object' && typeof (base as Record<string, unknown>).status_msg === 'string') return plainProviderText((base as Record<string, unknown>).status_msg)
  return plainProviderText(body)
}

async function readCapped(body: AsyncIterable<Buffer>): Promise<string> {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    if (size >= ERROR_BODY_MAX) continue
    parts.push(chunk.subarray(0, ERROR_BODY_MAX - size))
    size += chunk.length
  }
  return Buffer.concat(parts).toString('utf8')
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('aborted', 'The request was cancelled'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new ProviderError('aborted', 'The request was cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Jittered exponential backoff, 500 ms to 8 s. */
export function backoffMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

export type ErrorAnswer = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/**
 * POST `body` to `url` and return the open event stream. Non-2xx answers
 * become ProviderErrors (`classify` may refine one, e.g. Groq's
 * failed_generation); retryable ones are retried before streaming.
 */
export async function openEventStream(
  url: string,
  body: string,
  ep: Endpoint,
  opts: { signal: AbortSignal; sentOutputLimit: boolean; classify?: (answer: ErrorAnswer, base: ProviderError) => ProviderError; onRetry?: (waitMs: number, err: ProviderError) => void },
): Promise<SafeStream> {
  for (let attempt = 0; ; attempt++) {
    const observed = observingResolver()
    let failure: ProviderError
    try {
      const stream = await safeFetchStream(url, {
        method: 'POST',
        headers: headersFor(ep, { 'content-type': 'application/json', accept: 'text/event-stream' }),
        body,
        connectTimeoutMs: ep.connectTimeoutMs,
        idleTimeoutMs: ep.idleTimeoutMs,
        totalTimeoutMs: MODEL_CALL_MS,
        signal: opts.signal,
        localOrigins: ep.localOrigins,
        resolve: observed.resolve,
      })
      if (stream.status >= 200 && stream.status < 300) return stream
      let text = ''
      try {
        text = await readCapped(stream.body)
      } catch {
        // The error body itself failed to arrive: the status is the answer.
      } finally {
        stream.close()
      }
      const scrub = createScrubber([ep.apiKey])
      // Scrubbed before it is folded and capped: a key across the cap leaves nothing behind.
      const message = providerMessageOf(scrub.text(text))
      const { kind, retryable } = kindOfStatus(stream.status)
      const requestId = [stream.headers['x-request-id'], stream.headers['request-id']].map((v) => (Array.isArray(v) ? v[0] : v)).find((v) => typeof v === 'string') ?? null
      const base = new ProviderError(kind, `The provider answered ${stream.status}: ${message || 'no message'}`, {
        retryable,
        status: stream.status,
        retryAfterMs: retryAfterMs(stream.headers['retry-after']),
        requestId: requestId ? plainProviderText(requestId).slice(0, 100) : null,
        providerMessage: message,
        sentOutputLimit: opts.sentOutputLimit,
      })
      failure = opts.classify ? opts.classify({ status: stream.status, headers: stream.headers, body: scrub.text(text) }, base) : base
    } catch (err) {
      failure = transportError(err, ep, observed.seen)
    }
    // What this loop gives up on is final: the agent loop's own retry is for a stream that died after it opened.
    if (failure.kind === 'aborted' || !failure.retryable || attempt >= MAX_RETRIES) throw settled(failure)
    if (failure.retryAfterMs !== null && failure.retryAfterMs > RETRY_AFTER_MAX_MS) throw settled(failure)
    const wait = failure.retryAfterMs !== null ? failure.retryAfterMs : backoffMs(attempt)
    opts.onRetry?.(wait, failure)
    await sleep(wait, opts.signal)
  }
}

/**
 * GET `url` as JSON: a model list. `redirect: 'manual'` (F4): any 3xx from a
 * provider is a configuration error, so the key never follows one.
 */
export async function getJson(url: string, ep: Endpoint, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  const observed = observingResolver()
  let res
  try {
    res = await safeFetch(url, {
      method: 'GET',
      headers: headersFor(ep, { accept: 'application/json', ...extraHeaders }),
      timeoutMs: Math.min(ep.connectTimeoutMs, 60_000),
      maxBytes: 4 * 1024 * 1024,
      redirect: 'manual',
      localOrigins: ep.localOrigins,
      resolve: observed.resolve,
    })
  } catch (err) {
    throw transportError(err, ep, observed.seen)
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ProviderError('config', 'The provider answered with a redirect, which is never followed with a key. Check the base URL.', { status: res.status })
  }
  const text = res.body.toString('utf8')
  if (res.status < 200 || res.status >= 300) {
    const message = providerMessageOf(createScrubber([ep.apiKey]).text(text))
    const { kind } = kindOfStatus(res.status)
    throw new ProviderError(kind, `The provider answered ${res.status}: ${message || 'no message'}`, { status: res.status, providerMessage: message })
  }
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    throw new ProviderError('unknown', 'The provider’s model list is not JSON.')
  }
}

/** Join a path to a canonical base URL (the server joins paths; a base URL never carries a query). */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}
