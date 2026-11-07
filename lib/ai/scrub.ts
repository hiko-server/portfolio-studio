import type { LogFields, Logger } from '../log'

/**
 * Exact-value scrubbing (SERVER-ONLY, design §7.4, THREATS F7/F8). The
 * logger redacts by field NAME (lib/log SECRET_KEY); a provider error that
 * quotes the key in its message ("Incorrect API key provided: sk-…"), a stack
 * trace or a nested field slips past that. Here the literal values in play —
 * the stored provider key of this call, the bearer token of this request —
 * become `[secret]` in every string, Error messages and stacks included,
 * before anything reaches the log line, the System panel's log ring or the
 * error store (all three are fed from the logger).
 *
 *   const scrub = createScrubber([apiKey, token])
 *   const log = scrubbingLogger(baseLog, () => [apiKey, token])
 *   throw scrub.error(err)            // what leaves the provider layer
 *
 * Values shorter than 8 characters are ignored: no real key or token is that
 * short, and scrubbing short strings would mangle ordinary text. Besides the
 * literal, its URL-encoded and JSON-escaped spellings are replaced.
 */

export const SECRET_MARK = '[secret]'
const MIN_SECRET_LENGTH = 8
const MAX_DEPTH = 8

export type Scrubber = {
  /** True when at least one value is being scrubbed. */
  readonly active: boolean
  text(s: string): string
  /** A deep copy of `v` with every string scrubbed (Errors become scrubbed Errors). */
  value<T>(v: T): T
  /** A scrubbed copy of an error: name, message, stack, code, status and cause. */
  error(e: unknown): Error
}

function spellings(secret: string): string[] {
  const out = new Set([secret])
  try {
    out.add(encodeURIComponent(secret))
  } catch {
    // A lone surrogate cannot be URL-encoded: the literal is still covered.
  }
  out.add(JSON.stringify(secret).slice(1, -1))
  return [...out]
}

export function createScrubber(secrets: Iterable<string | null | undefined>): Scrubber {
  const needles = [...new Set([...secrets].filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH).flatMap(spellings))]
    // Longest first, so a secret that contains another is replaced whole.
    .sort((a, b) => b.length - a.length)

  const text = (s: string): string => {
    let out = s
    for (const n of needles) if (out.includes(n)) out = out.split(n).join(SECRET_MARK)
    return out
  }

  const error = (e: unknown, depth = 0): Error => {
    if (!(e instanceof Error)) return new Error(text(String(e)))
    const copy = new Error(text(e.message))
    copy.name = text(e.name)
    copy.stack = e.stack ? text(e.stack) : undefined
    const src = e as Error & { code?: unknown; status?: unknown; cause?: unknown }
    const dst = copy as Error & { code?: unknown; status?: unknown; cause?: unknown }
    if (src.code !== undefined) dst.code = typeof src.code === 'string' ? text(src.code) : src.code
    if (typeof src.status === 'number') dst.status = src.status
    if (src.cause !== undefined && depth < MAX_DEPTH) dst.cause = src.cause instanceof Error ? error(src.cause, depth + 1) : value(src.cause, depth + 1, new WeakSet())
    return copy
  }

  function value(v: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof v === 'string') return text(v)
    if (v === null || typeof v !== 'object') return v
    if (v instanceof Error) return error(v, depth)
    if (seen.has(v)) return '[circular]'
    if (depth >= MAX_DEPTH) return '[depth]'
    seen.add(v)
    if (Array.isArray(v)) return v.map((x) => value(x, depth + 1, seen))
    if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return '[binary]'
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[text(k)] = value(x, depth + 1, seen)
    return out
  }

  return {
    active: needles.length > 0,
    text,
    value: <T>(v: T) => value(v, 0, new WeakSet()) as T,
    error: (e: unknown) => error(e),
  }
}

/**
 * A logger whose messages and fields are scrubbed of the values `secrets()`
 * returns at the time of each call (so a key opened later is covered too).
 */
export function scrubbingLogger(base: Logger, secrets: () => Iterable<string | null | undefined>): Logger {
  const wrap =
    (fn: (msg: string, fields?: LogFields) => void) =>
    (msg: string, fields?: LogFields): void => {
      const s = createScrubber(secrets())
      if (!s.active) return fn(msg, fields)
      fn(s.text(msg), fields ? s.value(fields) : fields)
    }
  return {
    debug: wrap(base.debug),
    info: wrap(base.info),
    warn: wrap(base.warn),
    error: wrap(base.error),
    child: (fields) => scrubbingLogger(base.child(createScrubber(secrets()).value(fields)), secrets),
  }
}
