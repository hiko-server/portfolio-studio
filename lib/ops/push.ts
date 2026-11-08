import { log } from '../log'
import { safeFetch } from '../security/safeFetch'

/**
 * Push notifications to the owner's phone (SERVER-ONLY): the channels the
 * server's environment names, each optional and independent.
 *
 *   NOTIFY_NTFY_URL               https://ntfy.sh/<topic> (or your own ntfy server's topic URL)
 *   NOTIFY_NTFY_TOKEN             access token for a protected topic (optional)
 *   NOTIFY_TELEGRAM_BOT_TOKEN     a bot's token from @BotFather …
 *   NOTIFY_TELEGRAM_CHAT_ID       … and the chat it writes to (your user id or a group id)
 *   NOTIFY_BARK_URL               https://api.day.app/<device key> (or your own Bark server)
 *   NOTIFY_WEBHOOK_URL            any URL that takes a JSON POST; Slack and Discord
 *                                 incoming webhooks work as they are (the body carries
 *                                 `text` and `content`)
 *
 * What goes out is a title, a short text and a link to the admin page that
 * deals with it: never a secret, a token, a visitor's e-mail address or a
 * message body (lib/ops/alerts.ts writes the texts). Every request goes
 * through safeFetch (public HTTPS addresses only, 5 s), runs in the
 * background and never throws; a failure is logged with the channel's name,
 * never its URL (a topic or bot token in a URL is a credential).
 */

export type PushMessage = {
  title: string
  text: string
  /** Absolute URL the notification opens (an admin page). */
  url?: string
  /** 'high' for things that need a look today (a failed backup, a security event). */
  priority?: 'default' | 'high'
  /** Stable machine name of the event ("backup-failed"), for webhook consumers. */
  kind: string
}

export type PushChannel = 'ntfy' | 'telegram' | 'bark' | 'webhook'

export type PushRequest = { channel: PushChannel; url: string; headers: Record<string, string>; body: string }

type Env = Record<string, string | undefined>

const env = (e: Env, k: string) => (e[k] || '').trim()

function httpsUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The channels the environment configures (a malformed or non-HTTPS URL counts as not configured). */
export function configuredChannels(e: Env = process.env): PushChannel[] {
  const out: PushChannel[] = []
  const ntfy = httpsUrl(env(e, 'NOTIFY_NTFY_URL'))
  if (ntfy && ntfy.pathname.replace(/^\/+|\/+$/g, '')) out.push('ntfy')
  if (env(e, 'NOTIFY_TELEGRAM_BOT_TOKEN') && env(e, 'NOTIFY_TELEGRAM_CHAT_ID')) out.push('telegram')
  if (httpsUrl(env(e, 'NOTIFY_BARK_URL'))) out.push('bark')
  if (httpsUrl(env(e, 'NOTIFY_WEBHOOK_URL'))) out.push('webhook')
  return out
}

/** The HTTP request each configured channel gets for `m` (pure; unit tested). */
export function pushRequests(m: PushMessage, e: Env = process.env, product = 'Site'): PushRequest[] {
  const title = clip(m.title.replace(/\s+/g, ' ').trim(), 120)
  const text = clip(m.text.trim(), 1000)
  const json = { 'Content-Type': 'application/json' }
  const out: PushRequest[] = []
  for (const channel of configuredChannels(e)) {
    if (channel === 'ntfy') {
      // JSON publishing (to the server's root, topic in the body) keeps a
      // non-ASCII title intact, which a Title header would not.
      const u = httpsUrl(env(e, 'NOTIFY_NTFY_URL')) as URL
      const topic = u.pathname.replace(/^\/+|\/+$/g, '')
      const token = env(e, 'NOTIFY_NTFY_TOKEN')
      out.push({
        channel,
        url: `${u.origin}/`,
        headers: { ...json, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          topic,
          title,
          message: text,
          priority: m.priority === 'high' ? 4 : 3,
          tags: [m.kind],
          ...(m.url ? { click: m.url } : {}),
        }),
      })
    } else if (channel === 'telegram') {
      out.push({
        channel,
        url: `https://api.telegram.org/bot${env(e, 'NOTIFY_TELEGRAM_BOT_TOKEN')}/sendMessage`,
        headers: json,
        body: JSON.stringify({
          chat_id: env(e, 'NOTIFY_TELEGRAM_CHAT_ID'),
          text: [title, text, m.url].filter(Boolean).join('\n\n'),
          disable_web_page_preview: true,
        }),
      })
    } else if (channel === 'bark') {
      out.push({
        channel,
        url: env(e, 'NOTIFY_BARK_URL').replace(/\/+$/, ''),
        headers: json,
        body: JSON.stringify({
          title,
          body: text,
          group: product,
          ...(m.url ? { url: m.url } : {}),
          ...(m.priority === 'high' ? { level: 'timeSensitive' } : {}),
        }),
      })
    } else {
      const line = [title, text, m.url].filter(Boolean).join('\n')
      out.push({
        channel,
        url: env(e, 'NOTIFY_WEBHOOK_URL'),
        headers: json,
        body: JSON.stringify({
          kind: m.kind,
          title,
          message: text,
          url: m.url ?? null,
          priority: m.priority ?? 'default',
          // Slack ("text") and Discord ("content") incoming webhooks read these.
          text: line,
          content: clip(line, 1900),
        }),
      })
    }
  }
  return out
}

export type PushSender = (r: PushRequest) => Promise<{ status: number }>

const defaultSender: PushSender = async (r) => {
  const res = await safeFetch(r.url, { method: 'POST', headers: r.headers, body: r.body, timeoutMs: 5000, maxBytes: 64 * 1024, maxRedirects: 0 })
  return { status: res.status }
}

/**
 * Send `m` to every configured channel. Resolves once each has answered or
 * failed (callers do not wait: `void pushToOwner(…)`); the result says how
 * each one went, for the admin's "Send a test notification".
 */
export async function pushToOwner(
  m: PushMessage,
  opts: { env?: Env; send?: PushSender; product?: string } = {},
): Promise<Array<{ channel: PushChannel; ok: boolean; status?: number; error?: string }>> {
  const product = opts.product || process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Site'
  const send = opts.send || defaultSender
  const requests = pushRequests(m, opts.env || process.env, product)
  return Promise.all(
    requests.map(async (r) => {
      try {
        const { status } = await send(r)
        const ok = status >= 200 && status < 300
        if (!ok) log.warn('push notification refused', { channel: r.channel, kind: m.kind, status })
        return { channel: r.channel, ok, status }
      } catch (err) {
        const error = (err as { code?: string })?.code || (err as Error)?.name || 'failed'
        log.warn('push notification failed', { channel: r.channel, kind: m.kind, error })
        return { channel: r.channel, ok: false, error }
      }
    }),
  )
}
