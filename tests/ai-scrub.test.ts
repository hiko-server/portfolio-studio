/**
 * Exact-value scrubbing (design §7.4): the literal key or token of a call
 * becomes [secret] in every string — messages, fields, Error messages,
 * stacks, codes, causes — before the log line, the System panel's log ring
 * or the error store see it (all three are fed through the logger).
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { log, setLogObserver, type LogFields, type LogLevel } from '../lib/log'
import { createScrubber, scrubbingLogger, SECRET_MARK } from '../lib/ai/scrub'

const KEY = 'sk-test-SENTINEL-scrub-0123456789'
const TOKEN = 'pst_SENTINELtokenSecretPart0123456789abcdefghij'

afterEach(() => setLogObserver(null))

test('every spelling of every value is replaced; short values and ordinary text are left alone', () => {
  const s = createScrubber([KEY, TOKEN, 'short', null, undefined, ''])
  assert.equal(s.active, true)
  assert.equal(s.text(`401: Incorrect API key provided: ${KEY}.`), `401: Incorrect API key provided: ${SECRET_MARK}.`)
  assert.equal(s.text(`Bearer ${TOKEN} and ${TOKEN}`), `Bearer ${SECRET_MARK} and ${SECRET_MARK}`)
  const odd = 'key/with spaces+&"quote"'
  const t = createScrubber([odd])
  assert.equal(t.text(`url ?k=${encodeURIComponent(odd)}`), `url ?k=${SECRET_MARK}`)
  assert.equal(t.text(JSON.stringify({ k: odd })), `{"k":"${SECRET_MARK}"}`)
  assert.equal(s.text('a short value stays: short'), 'a short value stays: short')
  // A value that contains another is replaced whole.
  const nested = createScrubber(['abcdefgh', 'xxabcdefghyy'])
  assert.equal(nested.text('xxabcdefghyy abcdefgh'), `${SECRET_MARK} ${SECRET_MARK}`)
  assert.equal(createScrubber([]).active, false)
})

test('values are deep-copied scrubbed: keys, arrays, cycles, binary; the input is untouched', () => {
  const s = createScrubber([KEY])
  const input: Record<string, unknown> = { a: KEY, list: [1, `x ${KEY}`, { [KEY]: true }], buf: Buffer.from(KEY), nested: { deeper: { msg: KEY } } }
  input.self = input
  const out = s.value(input) as Record<string, unknown>
  assert.equal(out.a, SECRET_MARK)
  assert.deepEqual(out.list, [1, `x ${SECRET_MARK}`, { [SECRET_MARK]: true }])
  assert.equal(out.buf, '[binary]')
  assert.equal(out.self, '[circular]')
  assert.deepEqual(out.nested, { deeper: { msg: SECRET_MARK } })
  assert.equal(input.a, KEY, 'the caller keeps its own object')
  assert.doesNotMatch(JSON.stringify(out), /SENTINEL/)
})

test('errors: message, stack, code, cause scrubbed; name and status kept', () => {
  const s = createScrubber([KEY])
  const cause = new Error(`upstream said ${KEY}`)
  const err = Object.assign(new Error(`provider refused ${KEY}`, { cause }), { code: `E_${KEY}`, status: 401 })
  err.name = 'ProviderError'
  const out = s.error(err) as Error & { code?: unknown; status?: unknown; cause?: unknown }
  assert.equal(out.name, 'ProviderError')
  assert.equal(out.message, `provider refused ${SECRET_MARK}`)
  assert.equal(out.code, `E_${SECRET_MARK}`)
  assert.equal(out.status, 401)
  assert.equal((out.cause as Error).message, `upstream said ${SECRET_MARK}`)
  assert.doesNotMatch(`${out.stack}\n${(out.cause as Error).stack}`, /SENTINEL/)
  assert.equal(s.error(`thrown string ${KEY}`).message, `thrown string ${SECRET_MARK}`)
})

/** Capture what the logger writes (console) and what its observer (log ring, error store) receives. */
function capture(): { lines: string[]; observed: Array<{ level: LogLevel; msg: string; fields: LogFields }>; restore: () => void } {
  const lines: string[] = []
  const observed: Array<{ level: LogLevel; msg: string; fields: LogFields }> = []
  const saved = { log: console.log, error: console.error }
  console.log = (...a: unknown[]) => lines.push(a.join(' '))
  console.error = (...a: unknown[]) => lines.push(a.join(' '))
  setLogObserver((level, msg, fields) => observed.push({ level, msg, fields }))
  return { lines, observed, restore: () => Object.assign(console, saved) }
}

test('the scrubbing logger: nothing reaches the line or the observer; the plain logger would have leaked it', () => {
  const plain = capture()
  try {
    log.error(`provider call failed for ${KEY}`, { detail: `body: ${KEY}`, err: new Error(`401 ${KEY}`) })
  } finally {
    plain.restore()
  }
  assert.match(plain.lines.join('\n') + JSON.stringify(plain.observed.map((o) => [o.msg, String(o.fields.detail), (o.fields.err as Error).message])), /SENTINEL/, 'control: the name-based redaction alone does not catch it')

  let current: string[] = [KEY]
  const scrubbed = scrubbingLogger(log, () => current)
  const c = capture()
  try {
    scrubbed.error(`provider call failed for ${KEY}`, { detail: `body: ${KEY}`, err: new Error(`401 ${KEY}`), usageIn: 12 })
    scrubbed.warn('slow stream', { note: `still ${KEY}` })
    // A value added later (a token verified after the logger was made) is covered from then on.
    current = [KEY, TOKEN]
    scrubbed.child({ grant: `g ${TOKEN}` }).warn(`refused ${TOKEN}`)
  } finally {
    c.restore()
  }
  const all = c.lines.join('\n') + JSON.stringify(c.observed.map((o) => [o.msg, o.fields, o.fields.err instanceof Error ? `${o.fields.err.message} ${o.fields.err.stack}` : null]))
  assert.doesNotMatch(all, /SENTINEL/)
  assert.equal(c.observed.length, 3)
  assert.equal(c.observed[0].fields.usageIn, 12, 'ordinary fields stay')
  assert.match(c.observed[0].msg, /\[secret\]/)
})
