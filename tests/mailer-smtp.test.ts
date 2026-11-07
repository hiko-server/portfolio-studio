import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

// lib/mailer.sendMail against a fake SMTP server on 127.0.0.1: what reaches
// the wire (EHLO → AUTH → envelope → message) for the options the contact
// form, the inbox reply and the password reset pass. Pins the behaviour a
// nodemailer upgrade could change: SASL mechanism detection, the envelope
// (recipients come from `to` and `bcc` only, never from a visitor's
// Reply-To), the From display name, Message-ID / In-Reply-To / References
// (inbox threading) and a refused recipient failing the send.
// Synthetic values only (example.com / example.test).

type Session = {
  auth: { method: string; user: string; pass: string } | null
  mailFrom: string
  rcptTo: string[]
  data: string
  commands: string[]
}

type FakeSmtp = { port: number; sessions: Session[]; close: () => Promise<void> }

type FakeOptions = {
  /** The AUTH line of the EHLO reply, without the "250-" prefix. */
  authLine?: string
  pipelining?: boolean
  /** Recipients answered with 550. */
  refuse?: string[]
}

function startFakeSmtp({ authLine = 'AUTH PLAIN LOGIN', pipelining = true, refuse = [] }: FakeOptions = {}): Promise<FakeSmtp> {
  const sessions: Session[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    const s: Session = { auth: null, mailFrom: '', rcptTo: [], data: '', commands: [] }
    sessions.push(s)
    const reply = (line: string) => socket.write(`${line}\r\n`)
    let buffer = ''
    let mode: 'command' | 'data' | 'login-user' | 'login-pass' | 'plain' = 'command'
    let loginUser = ''

    const command = (line: string) => {
      s.commands.push(line.replace(/^(AUTH \w+) .+$/i, '$1 …'))
      const verb = line.split(' ')[0].toUpperCase()
      if (verb === 'EHLO') {
        const ext = ['smtp.example.test', ...(pipelining ? ['PIPELINING'] : []), '8BITMIME', 'SMTPUTF8', authLine, 'SIZE 10485760']
        ext.forEach((e, i) => reply(`250${i === ext.length - 1 ? ' ' : '-'}${e}`))
      } else if (verb === 'AUTH') {
        const [, method = '', initial] = line.split(' ')
        if (method.toUpperCase() === 'PLAIN') {
          if (initial) return plain(initial)
          mode = 'plain'
          reply('334 ')
        } else if (method.toUpperCase() === 'LOGIN') {
          mode = 'login-user'
          reply('334 VXNlcm5hbWU6')
        } else reply('504 5.5.4 Unrecognized authentication type')
      } else if (verb === 'MAIL') {
        s.mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? ''
        reply('250 2.1.0 Ok')
      } else if (verb === 'RCPT') {
        const to = /<([^>]*)>/.exec(line)?.[1] ?? ''
        if (refuse.includes(to)) return reply('550 5.1.1 <' + to + '>: Recipient address rejected')
        s.rcptTo.push(to)
        reply('250 2.1.5 Ok')
      } else if (verb === 'DATA') {
        if (!s.rcptTo.length) return reply('554 5.5.1 No valid recipients')
        mode = 'data'
        reply('354 End data with <CR><LF>.<CR><LF>')
      } else if (verb === 'RSET' || verb === 'NOOP') reply('250 2.0.0 Ok')
      else if (verb === 'QUIT') {
        reply('221 2.0.0 Bye')
        socket.end()
      } else reply('502 5.5.2 Error: command not recognized')
    }

    const plain = (b64: string) => {
      const [, user = '', pass = ''] = Buffer.from(b64, 'base64').toString('utf8').split('\u0000')
      s.auth = { method: 'PLAIN', user, pass }
      mode = 'command'
      reply('235 2.7.0 Authentication successful')
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        if (mode === 'data') {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          s.data = buffer.slice(0, end).replace(/^\.\./gm, '.')
          buffer = buffer.slice(end + 5)
          mode = 'command'
          reply('250 2.0.0 Ok: queued as FAKE1')
          continue
        }
        const nl = buffer.indexOf('\r\n')
        if (nl < 0) return
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 2)
        if (mode === 'plain') plain(line)
        else if (mode === 'login-user') {
          loginUser = Buffer.from(line, 'base64').toString('utf8')
          mode = 'login-pass'
          reply('334 UGFzc3dvcmQ6')
        } else if (mode === 'login-pass') {
          s.auth = { method: 'LOGIN', user: loginUser, pass: Buffer.from(line, 'base64').toString('utf8') }
          mode = 'command'
          reply('235 2.7.0 Authentication successful')
        } else command(line)
      }
    })
    reply('220 smtp.example.test ESMTP fake')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      resolve({
        port,
        sessions,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

const SMTP_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'FROM_EMAIL'] as const
const savedEnv = Object.fromEntries(SMTP_ENV.map((k) => [k, process.env[k]]))
after(() => {
  for (const k of SMTP_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

const USER = 'mailer@example.test'
const PASS = 'synthetic-smtp-secret'

function useServer(port: number) {
  process.env.SMTP_HOST = '127.0.0.1'
  process.env.SMTP_PORT = String(port)
  process.env.SMTP_USER = USER
  process.env.SMTP_PASS = PASS
  delete process.env.FROM_EMAIL
}

/** Header fields of a message (unfolded, encoded words decoded), by lowercase name. */
function headersOf(raw: string): Map<string, string[]> {
  const head = raw.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ')
  const out = new Map<string, string[]>()
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':')
    if (i < 1) continue
    const name = line.slice(0, i).toLowerCase()
    out.set(name, [...(out.get(name) || []), decodeWords(line.slice(i + 1).trim())])
  }
  return out
}

/** RFC 2047 encoded words (UTF-8, B and Q); whitespace between two encoded words is dropped. */
function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BQ]\?[^?]*\?=)\s+(?==\?)/gi, '$1')
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_m, _charset: string, enc: string, text: string) =>
      enc.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_h, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8'),
    )
}

function one(h: Map<string, string[]>, name: string): string {
  const v = h.get(name)
  assert.ok(v && v.length === 1, `exactly one ${name} header (got ${JSON.stringify(v)})`)
  return v[0]
}

for (const { authLine, method } of [
  { authLine: 'AUTH PLAIN', method: 'PLAIN' },
  { authLine: 'AUTH LOGIN', method: 'LOGIN' },
  { authLine: 'AUTH=LOGIN', method: 'LOGIN' },
  { authLine: 'AUTH CRAM-MD5 LOGIN', method: 'LOGIN' },
  { authLine: 'AUTH LOGIN PLAIN XOAUTH2', method: '' },
]) {
  test(`SMTP login with the configured account when the server offers "${authLine}"`, async () => {
    const smtp = await startFakeSmtp({ authLine })
    try {
      useServer(smtp.port)
      const { sendMail } = await import('../lib/mailer')
      const result = await sendMail({ to: 'owner@example.test', subject: 'Password Reset', text: 'Reset your password: https://example.com/reset' })
      assert.equal(result.ok, true)
      assert.equal(smtp.sessions.length, 1)
      const [s] = smtp.sessions
      assert.ok(s.auth, `logged in (commands: ${s.commands.join(' | ')})`)
      assert.equal(s.auth.user, USER)
      assert.equal(s.auth.pass, PASS)
      if (method) assert.equal(s.auth.method, method)
      else assert.ok(['PLAIN', 'LOGIN'].includes(s.auth.method), s.auth.method)
      // FROM_EMAIL unset: the SMTP account is the sender.
      assert.equal(s.mailFrom, USER)
      assert.deepEqual(s.rcptTo, ['owner@example.test'])
    } finally {
      await smtp.close()
    }
  })
}

for (const pipelining of [true, false]) {
  test(`inbox reply: envelope, From name, threading headers and Message-ID (PIPELINING ${pipelining ? 'on' : 'off'})`, async () => {
    const smtp = await startFakeSmtp({ pipelining })
    try {
      useServer(smtp.port)
      const { sendMail } = await import('../lib/mailer')
      const messageId = '<reply.0123456789abcdef01234567@example.test>'
      const result = await sendMail({
        from: { name: 'Synthetic Owner（测试）', address: 'owner@example.test' },
        to: 'visitor@example.com',
        subject: 'Re: 关于合作 — a synthetic subject',
        text: 'Thanks for writing.\n.a line that starts with a dot\nSynthetic Owner',
        replyTo: 'replies@example.test',
        bcc: 'copy@example.test',
        messageId,
        inReplyTo: '<reply.1@example.test>',
        references: ['<contact.0@example.test>', '<reply.1@example.test>'],
      })
      assert.deepEqual(result, { ok: true, messageId })

      const [s] = smtp.sessions
      assert.equal(s.mailFrom, 'owner@example.test')
      assert.deepEqual([...s.rcptTo].sort(), ['copy@example.test', 'visitor@example.com'])

      const h = headersOf(s.data)
      assert.equal(one(h, 'from'), 'Synthetic Owner（测试） <owner@example.test>')
      assert.equal(one(h, 'to'), 'visitor@example.com')
      assert.equal(one(h, 'reply-to'), 'replies@example.test')
      assert.equal(h.has('bcc'), false, 'Bcc stays out of the message')
      assert.equal(one(h, 'subject'), 'Re: 关于合作 — a synthetic subject')
      assert.equal(one(h, 'message-id'), messageId)
      assert.equal(one(h, 'in-reply-to'), '<reply.1@example.test>')
      assert.deepEqual(one(h, 'references').split(/\s+/), ['<contact.0@example.test>', '<reply.1@example.test>'])

      const body = s.data.split('\r\n\r\n').slice(1).join('\r\n\r\n')
      assert.match(body, /^\.a line that starts with a dot$/m, 'dot-stuffing round-trips')
    } finally {
      await smtp.close()
    }
  })
}

// pages/api/contact.ts accepts any /^[^\s@]+@[^\s@]+\.[^\s@]+$/ address and
// sends it as Reply-To: these pass that check and carry the comment, quote,
// group and angle-bracket shapes of the 2026 addressparser advisories.
const CONTACT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TRICKY_REPLY_TO = [
  'visitor@example.com',
  '(note)visitor@example.com',
  'visitor(note)@example.com',
  'a(b(c)d)e@example.com',
  '"a;b"@example.com',
  '"x>"@evil.example',
  'list:victim@evil.example;',
  '<victim@evil.example>',
  'x,victim@evil.example',
]

test('contact form: a visitor-supplied Reply-To never becomes a recipient', async () => {
  const smtp = await startFakeSmtp()
  try {
    useServer(smtp.port)
    const { sendMail } = await import('../lib/mailer')
    for (const replyTo of TRICKY_REPLY_TO) {
      assert.match(replyTo, CONTACT_EMAIL_RE, `${replyTo} passes the contact form's check`)
      const result = await sendMail({ to: 'owner@example.test', subject: '[Contact] synthetic', text: 'From the contact form.', replyTo })
      assert.equal(result.ok, true, replyTo)
    }
    assert.equal(smtp.sessions.length, TRICKY_REPLY_TO.length)
    smtp.sessions.forEach((s, i) => {
      assert.equal(s.mailFrom, USER, TRICKY_REPLY_TO[i])
      assert.deepEqual(s.rcptTo, ['owner@example.test'], TRICKY_REPLY_TO[i])
      assert.equal(one(headersOf(s.data), 'to'), 'owner@example.test')
    })
    assert.equal(one(headersOf(smtp.sessions[0].data), 'reply-to'), 'visitor@example.com')
  } finally {
    await smtp.close()
  }
})

test('notifications: FROM_EMAIL with a display name is the sender, envelope and header', async () => {
  const smtp = await startFakeSmtp()
  try {
    useServer(smtp.port)
    process.env.FROM_EMAIL = '"Synthetic Site, Notices" <noreply@example.test>'
    const { sendMail } = await import('../lib/mailer')
    assert.equal((await sendMail({ to: 'owner@example.test', subject: 'Password Reset', text: 'Reset.' })).ok, true)
    const [s] = smtp.sessions
    assert.equal(s.mailFrom, 'noreply@example.test')
    assert.deepEqual(s.rcptTo, ['owner@example.test'])
    assert.equal(one(headersOf(s.data), 'from'), '"Synthetic Site, Notices" <noreply@example.test>')
  } finally {
    delete process.env.FROM_EMAIL
    await smtp.close()
  }
})

test('a refused recipient fails the send (the inbox reply reports 502)', async () => {
  const smtp = await startFakeSmtp({ refuse: ['gone@example.com'] })
  try {
    useServer(smtp.port)
    const { sendMail } = await import('../lib/mailer')
    await assert.rejects(sendMail({ to: 'gone@example.com', subject: 'Re: synthetic', text: 'Hello.' }), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /gone@example\.com|recipient/i)
      return true
    })
  } finally {
    await smtp.close()
  }
})

test('SMTP not configured: the message is skipped without a connection', async () => {
  for (const k of SMTP_ENV) delete process.env[k]
  const { sendMail } = await import('../lib/mailer')
  assert.deepEqual(await sendMail({ to: 'owner@example.test', subject: 'x', text: 'y' }), { ok: false, skipped: true })
})
