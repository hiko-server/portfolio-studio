import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatJsonLine, isSecretKey, sanitize } from '../lib/log'

test('secret-looking keys are redacted, including connection URIs and DSNs', () => {
  const out = sanitize({
    password: 'p',
    adminPass: 'p',
    clientSecret: 's',
    refreshToken: 't',
    Authorization: 'Bearer x',
    cookie: 'c',
    MONGODB_URI: 'mongodb://user:pw@host',
    mongoUri: 'mongodb://user:pw@host',
    uri: 'x',
    SENTRY_DSN: 'https://k@o.ingest.sentry.io/1',
    nested: { dsn: 'd', ok: 'v' },
  }) as Record<string, unknown>
  for (const k of ['password', 'adminPass', 'clientSecret', 'refreshToken', 'Authorization', 'cookie', 'MONGODB_URI', 'mongoUri', 'uri', 'SENTRY_DSN']) {
    assert.equal(out[k], '[redacted]', k)
  }
  assert.deepEqual(out.nested, { dsn: '[redacted]', ok: 'v' })
})

test('ordinary keys that merely contain "uri" survive', () => {
  for (const k of ['security', 'curious', 'during', 'route', 'url', 'requestId']) assert.equal(isSecretKey(k), false, k)
  const out = sanitize({ security: 'csp', route: 'health' }) as Record<string, unknown>
  assert.deepEqual(out, { security: 'csp', route: 'health' })
})

test('production line is one JSON object {ts, level, msg, ...fields} with errors expanded', () => {
  const now = new Date('2026-10-13T08:00:00.000Z')
  const err = new Error('disk full')
  const line = formatJsonLine('error', 'backup failed', { err, filename: 'snapshot.tgz', token: 'abc' }, now)
  assert.equal(line.includes('\n'), false)
  const parsed = JSON.parse(line)
  assert.deepEqual(Object.keys(parsed).slice(0, 3), ['ts', 'level', 'msg'])
  assert.equal(parsed.ts, '2026-10-13T08:00:00.000Z')
  assert.equal(parsed.level, 'error')
  assert.equal(parsed.msg, 'backup failed')
  assert.equal(parsed.filename, 'snapshot.tgz')
  assert.equal(parsed.token, '[redacted]')
  assert.equal(parsed.err.name, 'Error')
  assert.equal(parsed.err.message, 'disk full')
  assert.match(parsed.err.stack, /disk full/)
})

test('fields can never overwrite ts, level or msg', () => {
  const parsed = JSON.parse(formatJsonLine('info', 'real', { ts: 'fake', level: 'error', msg: 'spoofed', extra: 1 }))
  assert.equal(parsed.msg, 'real')
  assert.equal(parsed.level, 'info')
  assert.notEqual(parsed.ts, 'fake')
  assert.equal(parsed.extra, 1)
})

test('OAuth and bearer values are redacted by name; bare key and code names are not (AI design §7.4)', () => {
  const secretKeys = ['code_verifier', 'codeVerifier', 'verifier', 'refresh', 'refresh_token', 'bearer', 'bearerValue', 'auth_code', 'authCode', 'auth-code', 'authcode']
  for (const k of secretKeys) assert.equal(isSecretKey(k), true, k)
  // Ordinary fields keep their values: a store key, an error code, usage counts named the AI way.
  for (const k of ['key', 'code', 'status', 'usageIn', 'usageOut', 'cachedRead', 'paths', 'provider', 'model']) assert.equal(isSecretKey(k), false, k)
  const out = sanitize({ code: 'VERSION_CONFLICT', key: 'blog/example', usageIn: 120, usageOut: 40, code_verifier: 'v', refresh_token: 'r', authCode: 'a', bearer: 'b' }) as Record<string, unknown>
  assert.deepEqual(out, { code: 'VERSION_CONFLICT', key: 'blog/example', usageIn: 120, usageOut: 40, code_verifier: '[redacted]', refresh_token: '[redacted]', authCode: '[redacted]', bearer: '[redacted]' })
})
