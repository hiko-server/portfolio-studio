import type { NextApiRequest } from 'next'
import { ipPrefix } from '../adminAuth/describe'
import { isLocalOnly } from '../env'
import { ipFromReq } from '../rateLimit'

/**
 * The HTTP rules of /mcp (SERVER-ONLY, design §6.3) that are not the SDK's:
 * the canonical resource, the Host and Origin checks, the bearer challenges.
 *
 * The MCP resource and the OAuth issuer come from SITE_URL, never from the
 * Host header. Host must name exactly the host and port of SITE_URL
 * (X-Forwarded-Host is ignored), and an Origin, when a browser sends one,
 * must be the site's own or a known AI client's: DNS rebinding cannot pass
 * either check. lib/security/csrf's checkCsrf is never used here — it would
 * accept a rebound name (THREATS F1).
 */

/** Browser origins of hosted AI clients (§6.3): https on exactly these hosts. */
export const CLIENT_ORIGIN_HOSTS: readonly string[] = ['claude.ai', 'claude.com', 'chatgpt.com', 'chat.openai.com', 'www.cursor.com', 'vscode.dev']
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** SITE_URL as a URL (its origin is the issuer), or null when it is unset or does not parse. */
export function siteUrl(): URL | null {
  const raw = (process.env.SITE_URL || '').trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

/** The canonical MCP resource, `<SITE_URL origin>/mcp` (no trailing slash), or null without SITE_URL. */
export function canonicalResource(): string | null {
  const site = siteUrl()
  return site ? `${site.origin}/mcp` : null
}

/** Where the Protected Resource Metadata of /mcp is served (RFC 9728). */
export function resourceMetadataUrl(): string | null {
  const site = siteUrl()
  return site ? `${site.origin}/.well-known/oauth-protected-resource/mcp` : null
}

/** Does the Host header name exactly SITE_URL's host and port (case and default port aside)? */
export function hostMatches(hostHeader: string | string[] | undefined, site: URL): boolean {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader
  if (typeof raw !== 'string' || !raw || /[\s/\\@?#]/.test(raw)) return false
  try {
    return new URL(`${site.protocol}//${raw}`).host === site.host
  } catch {
    return false
  }
}

/**
 * Is a present Origin allowed? The site's own origin; a hosted AI client's
 * (https, exact host); a loopback origin only while the site is local-only.
 * `null` and anything that does not parse are refused.
 */
export function originAllowed(origin: string, site: URL): boolean {
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  if (u.origin === 'null' || u.origin !== origin.replace(/\/$/, '')) return false
  if (u.origin === site.origin) return true
  if (u.protocol === 'https:' && !u.port && CLIENT_ORIGIN_HOSTS.includes(u.hostname)) return true
  return isLocalOnly() && (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)
}

const quoted = (v: string) => `"${v.replace(/[\\"]/g, '')}"`

/** A `WWW-Authenticate: Bearer ...` value (RFC 6750, RFC 9728's resource_metadata). */
export function bearerChallenge(fields: { error?: 'invalid_token' | 'insufficient_scope' | 'invalid_request'; description?: string; scope?: string; resourceMetadata: string }): string {
  const parts: string[] = []
  if (fields.error) parts.push(`error=${quoted(fields.error)}`)
  if (fields.description) parts.push(`error_description=${quoted(fields.description)}`)
  if (fields.scope) parts.push(`scope=${quoted(fields.scope)}`)
  parts.push(`resource_metadata=${quoted(fields.resourceMetadata)}`)
  return `Bearer ${parts.join(', ')}`
}

/** The client's network, as the call log and the grant keep it: a coarse prefix and Cloudflare's country. */
export function requestNetwork(req: NextApiRequest): { ipPrefix: string | null; country: string | null } {
  const raw = req.headers['cf-ipcountry']
  const country = (Array.isArray(raw) ? raw[0] : raw || '').toUpperCase()
  return {
    ipPrefix: ipPrefix(ipFromReq(req)),
    country: /^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1' ? country : null,
  }
}
